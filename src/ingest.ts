// Applies record events to the index (#2). Both the Jetstream consumer (#3)
// and the reconcile (#4) feed it; it does no network I/O.
//
// Events have Jetstream's shape. Applying the same events again gives the
// same database (Jetstream delivers at least once, and replays overlap).
import { Lexicons, jsonToLex } from '@atproto/lexicon';
import { decode } from '@hikeratlas/route-keys';
import { LEXICONS, NSID } from './lexicons';

export interface CommitEvent {
  kind: 'commit';
  did: string;
  time_us?: number;
  commit: {
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    cid?: string;
    record?: Record<string, unknown>;
  };
}
export interface AccountEvent {
  kind: 'account';
  did: string;
  time_us?: number;
  account: { active: boolean; status?: string };
}
export interface IdentityEvent {
  kind: 'identity';
  did: string;
  time_us?: number;
  identity: { handle?: string };
}
export type IndexEvent = CommitEvent | AccountEvent | IdentityEvent;

export interface IngestStats {
  applied: number;
  // Not stored, by reason.
  skipped: Record<string, number>;
}

const lexicons = new Lexicons(LEXICONS);
const INDEXED = new Set<string>([NSID.Fave, NSID.Track, NSID.Review]);
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+)$/;
// Record keys, per the atproto spec (and never . or ..).
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

// The route key's centroid cell, or null if it isn't a route key we can read.
function cellOf(key: string): string | null {
  try {
    return decode(key).centroid;
  } catch {
    return null;
  }
}

// Why a create or update can't be stored, or null if it can. Also returns
// what to store about its route.
function check(e: CommitEvent): { reason: string } | { routeKey: string | null; cell: string | null } {
  const { collection, rkey, cid, record } = e.commit;
  if (!cid) return { reason: 'no-cid' };
  if (!record || typeof record !== 'object') return { reason: 'no-record' };
  if (record.$type !== collection) return { reason: 'wrong-type' };
  try {
    lexicons.assertValidRecord(collection, jsonToLex(record));
  } catch {
    return { reason: 'invalid' };
  }
  if (collection === NSID.Profile) return rkey === 'self' ? { routeKey: null, cell: null } : { reason: 'bad-rkey' };
  // A fave's record key is its route; a track or review may name one.
  const key = collection === NSID.Fave ? rkey : (record.routeKey as string | undefined);
  if (key === undefined) return { routeKey: null, cell: null };
  const cell = cellOf(key);
  // A key we can't read (malformed, or a recipe newer than our route-keys):
  // skipped, so a reconcile picks it up once the library can.
  return cell ? { routeKey: key, cell } : { reason: 'bad-route-key' };
}

// The statements one event becomes, or the reason it's skipped.
function statements(db: D1Database, e: IndexEvent, now: string): D1PreparedStatement[] | string {
  if (!DID.test(e.did)) return 'bad-did';
  if (e.kind === 'identity') {
    // Only for accounts we know; a missing handle leaves it as it was.
    if (!e.identity.handle) return [];
    return [db.prepare('UPDATE actors SET handle = ?1 WHERE did = ?2').bind(e.identity.handle.toLowerCase(), e.did)];
  }
  if (e.kind === 'account') {
    if (!e.account.active && e.account.status === 'deleted') {
      return [
        db.prepare('DELETE FROM records WHERE did = ?1').bind(e.did),
        db.prepare('DELETE FROM actors WHERE did = ?1').bind(e.did),
      ];
    }
    const status = e.account.active ? 'active' : (e.account.status ?? 'deactivated');
    return [db.prepare('UPDATE actors SET status = ?1 WHERE did = ?2').bind(status, e.did)];
  }

  const { operation, collection, rkey } = e.commit;
  if (collection !== NSID.Profile && !INDEXED.has(collection)) return 'other-collection';
  if (!RKEY.test(rkey) || rkey === '.' || rkey === '..') return 'bad-rkey';
  const uri = `at://${e.did}/${collection}/${rkey}`;

  if (operation === 'delete') {
    if (collection === NSID.Profile) {
      return rkey === 'self' ? [db.prepare('UPDATE actors SET has_profile = 0 WHERE did = ?1').bind(e.did)] : [];
    }
    return [db.prepare('DELETE FROM records WHERE uri = ?1').bind(uri)];
  }

  const ok = check(e);
  if ('reason' in ok) return ok.reason;
  if (collection === NSID.Profile) {
    return [db.prepare(
      `INSERT INTO actors (did, has_profile, seen_at) VALUES (?1, 1, ?2)
       ON CONFLICT (did) DO UPDATE SET has_profile = 1, seen_at = ?2`,
    ).bind(e.did, now)];
  }
  const record = e.commit.record!;
  return [
    db.prepare('INSERT INTO actors (did, seen_at) VALUES (?1, ?2) ON CONFLICT (did) DO UPDATE SET seen_at = ?2').bind(e.did, now),
    db.prepare(
      `INSERT INTO records (uri, did, collection, rkey, cid, route_key, cell, created_at, indexed_at, json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (uri) DO UPDATE SET cid = ?5, route_key = ?6, cell = ?7, created_at = ?8, indexed_at = ?9, json = ?10`,
    ).bind(uri, e.did, collection, rkey, e.commit.cid!, ok.routeKey, ok.cell, record.createdAt as string, now, JSON.stringify(record)),
  ];
}

// Applies events in order, in one D1 batch.
export async function ingest(db: D1Database, events: IndexEvent[], now = new Date().toISOString()): Promise<IngestStats> {
  const stats: IngestStats = { applied: 0, skipped: {} };
  const batch: D1PreparedStatement[] = [];
  for (const e of events) {
    const s = statements(db, e, now);
    if (typeof s === 'string') {
      stats.skipped[s] = (stats.skipped[s] ?? 0) + 1;
      continue;
    }
    stats.applied++;
    batch.push(...s);
  }
  if (batch.length) await db.batch(batch);
  return stats;
}
