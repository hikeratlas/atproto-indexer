// Read-your-writes (#15): the website calls POST /notify with a record's
// at:// URI right after writing or deleting it, and the indexer applies
// that one record now instead of waiting up to a minute for Jetstream.
//
// It trusts only the author's PDS: the record is fetched from there, and
// one that's gone is removed. So a caller can only make the indexer read a
// record that really exists (or forget one that really doesn't).
import { type IndexEvent, ingest } from './ingest';
import { NSID } from './lexicons';
import { getJson, resolveDid, verifiedHandle } from './reconcile';

type Fetch = typeof fetch;

const COLLECTIONS = new Set<string>([NSID.Profile, NSID.Fave, NSID.Track, NSID.Review]);
const URI = /^at:\/\/(did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+))\/([a-zA-Z0-9.-]+)\/([A-Za-z0-9._:~-]{1,512})$/;

// Best effort, per isolate: an account's notifies per minute. The real bound
// is that each one costs a PDS fetch and an upsert of a record that exists.
export const PER_MINUTE = 30;
const recent = new Map<string, number[]>();

function allowed(did: string, nowMs: number): boolean {
  const ts = (recent.get(did) ?? []).filter((t) => nowMs - t < 60_000);
  if (ts.length >= PER_MINUTE) { recent.set(did, ts); return false; }
  ts.push(nowMs);
  recent.set(did, ts);
  if (recent.size > 10_000) recent.clear();
  return true;
}

export type NotifyResult =
  | { status: 200; body: { uri: string; indexed: boolean; skipped?: Record<string, number> } }
  | { status: 400 | 429 | 502; body: { error: string; message: string } };

export async function notify(db: D1Database, f: Fetch, uri: unknown, nowMs = Date.now()): Promise<NotifyResult> {
  const m = typeof uri === 'string' ? URI.exec(uri) : null;
  if (!m || !COLLECTIONS.has(m[2])) return { status: 400, body: { error: 'InvalidRequest', message: 'uri must be an at:// URI of a Hiker Atlas record' } };
  const [, did, collection, rkey] = m;
  if (!allowed(did, nowMs)) return { status: 429, body: { error: 'RateLimitExceeded', message: 'Too many notifies for this account' } };

  // The account's PDS: known already, else from its DID document.
  const known = await db.prepare('SELECT pds FROM actors WHERE did = ?1').bind(did).first<{ pds: string | null }>();
  let pds = known?.pds || null;
  let doc: { pds: string; handle: string | null } | null = null;
  if (!pds) {
    doc = await resolveDid(f, did);
    if (!doc) return { status: 502, body: { error: 'UpstreamFailure', message: "Can't resolve the account's PDS" } };
    pds = doc.pds;
  }

  const r = await getJson<{ uri: string; cid: string; value: Record<string, unknown> }>(f,
    `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`);
  let event: IndexEvent;
  if (r.ok) {
    event = { kind: 'commit', did, commit: { operation: 'create', collection, rkey, cid: r.body.cid, record: r.body.value } };
  } else if (r.status === 400 || r.status === 404) {
    // RecordNotFound (and older PDSes' 404): it's gone.
    event = { kind: 'commit', did, commit: { operation: 'delete', collection, rkey } };
  } else {
    return { status: 502, body: { error: 'UpstreamFailure', message: `getRecord: HTTP ${r.status}` } };
  }

  const stats = await ingest(db, [event]);
  // A new account: its PDS and handle now, rather than at the next reconcile.
  if (doc && r.ok) {
    await db.prepare('UPDATE actors SET pds = ?1, handle = ?2 WHERE did = ?3').bind(doc.pds, await verifiedHandle(f, did, doc.handle), did).run();
  }
  const indexed = event.commit.operation === 'create' && stats.applied === 1;
  return { status: 200, body: { uri: uri as string, indexed, ...(stats.applied ? {} : { skipped: stats.skipped }) } };
}
