// Reconciles the index with people's own repositories (#4). Jetstream can
// miss things (downtime longer than its history, bugs, schema changes), and
// what it relays is unauthenticated; this reads the truth from each PDS.
//
// It runs in slices, from its own cron: listing Hiker Atlas's users (the
// relay's listReposByCollection for the profile record, plus every account
// already indexed) into a queue, then a few repos per slice, so each run
// stays within the Free plan's CPU and subrequest limits. A pass starts
// daily, when Jetstream asks for one (its cursor was too old), or from the
// admin endpoint.
import { type IndexEvent, ingest } from './ingest';
import { NSID } from './lexicons';
import { RECONCILE_REQUESTED } from './jetstream';
import { getState, setState } from './state';

export const RELAY = 'https://relay1.us-east.bsky.network';
export const PLC = 'https://plc.directory';
export const HANDLE_RESOLVER = 'https://public.api.bsky.app';
// About 7 fetches a repo (DID document, repo status, handle, profile, three
// collections): 4 repos stay well inside the Free plan's 50 subrequests.
export const REPOS_PER_SLICE = 4;
export const RECORDS_PER_SLICE = 300; // records to validate; a repo is never split
export const EVERY_MS = 24 * 3600_000;

export const QUEUE = 'reconcile.queue';
export const STARTED = 'reconcile.started';
export const LAST = 'reconcile.last';

const COLLECTIONS = [NSID.Fave, NSID.Track, NSID.Review];
type Fetch = typeof fetch;

interface Pass {
  started: string;
  repos: number;
  events: number;
  errors: string[];
}

async function getJson<T>(f: Fetch, url: string): Promise<{ ok: true; body: T } | { ok: false; status: number; error?: string }> {
  const r = await f(url, { headers: { accept: 'application/json', 'user-agent': 'hikeratlas-indexer' } });
  if (r.ok) return { ok: true, body: (await r.json()) as T };
  let error: string | undefined;
  try { error = ((await r.json()) as { error?: string }).error; } catch { /* no body */ }
  return { ok: false, status: r.status, error };
}

// Every DID with a Hiker Atlas profile, per the relay.
export async function listUsers(f: Fetch): Promise<string[]> {
  const dids: string[] = [];
  let cursor: string | undefined;
  do {
    const u = new URL(`${RELAY}/xrpc/com.atproto.sync.listReposByCollection`);
    u.searchParams.set('collection', NSID.Profile);
    u.searchParams.set('limit', '2000');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await getJson<{ repos: { did: string }[]; cursor?: string }>(f, u.toString());
    if (!r.ok) throw new Error(`listReposByCollection: HTTP ${r.status}`);
    dids.push(...r.body.repos.map((x) => x.did));
    cursor = r.body.cursor;
  } while (cursor);
  return dids;
}

// A DID's PDS and claimed handle, from its DID document.
export async function resolveDid(f: Fetch, did: string): Promise<{ pds: string; handle: string | null } | null> {
  const url = did.startsWith('did:plc:') ? `${PLC}/${did}` : `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
  const r = await getJson<{ alsoKnownAs?: string[]; service?: { id: string; type: string; serviceEndpoint: string }[] }>(f, url);
  if (!r.ok) return null;
  const pds = r.body.service?.find((s) => s.id.endsWith('#atproto_pds') && s.type === 'AtprotoPersonalDataServer')?.serviceEndpoint;
  if (!pds || !/^https:\/\//.test(pds)) return null;
  const handle = r.body.alsoKnownAs?.find((a) => a.startsWith('at://'))?.slice('at://'.length).toLowerCase() ?? null;
  return { pds: pds.replace(/\/$/, ''), handle };
}

// The handle only if it resolves back to the DID: a DID document can claim any.
async function verifiedHandle(f: Fetch, did: string, handle: string | null): Promise<string | null> {
  if (!handle) return null;
  const r = await getJson<{ did: string }>(f, `${HANDLE_RESOLVER}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
  return r.ok && r.body.did === did ? handle : null;
}

interface Listed { uri: string; cid: string; value: Record<string, unknown> }

async function listRecords(f: Fetch, pds: string, did: string, collection: string): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | undefined;
  do {
    const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set('repo', did);
    u.searchParams.set('collection', collection);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await getJson<{ records: Listed[]; cursor?: string }>(f, u.toString());
    if (!r.ok) throw new Error(`listRecords ${collection}: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
    out.push(...r.body.records);
    cursor = r.body.records.length ? r.body.cursor : undefined;
  } while (cursor);
  return out;
}

export interface RepoResult {
  events: IndexEvent[];
  fetched: number; // records listed
  actor?: { pds: string; handle: string | null };
}

// The events that bring one repo's rows in line with its PDS: new and
// changed records (by CID), deletes for rows that are gone, the profile,
// and the account's status; and its PDS and verified handle.
export async function reconcileRepo(db: D1Database, f: Fetch, did: string): Promise<RepoResult> {
  const doc = await resolveDid(f, did);
  if (!doc) throw new Error(`${did}: can't resolve`);
  const status = await getJson<{ active: boolean; status?: string }>(f, `${doc.pds}/xrpc/com.atproto.sync.getRepoStatus?did=${encodeURIComponent(did)}`);
  if (!status.ok) {
    if (status.error === 'RepoNotFound') return { events: [{ kind: 'account', did, account: { active: false, status: 'deleted' } }], fetched: 0 };
    throw new Error(`${did}: getRepoStatus HTTP ${status.status}`);
  }
  const actor = { pds: doc.pds, handle: await verifiedHandle(f, did, doc.handle) };
  if (!status.body.active) {
    return { events: [{ kind: 'account', did, account: { active: false, status: status.body.status ?? 'deactivated' } }], fetched: 0, actor };
  }

  const events: IndexEvent[] = [];
  const profile = await getJson<Listed>(f, `${doc.pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${NSID.Profile}&rkey=self`);
  if (profile.ok) {
    events.push({ kind: 'commit', did, commit: { operation: 'create', collection: NSID.Profile, rkey: 'self', cid: profile.body.cid, record: profile.body.value } });
  } else if (profile.status === 400 || profile.status === 404) {
    events.push({ kind: 'commit', did, commit: { operation: 'delete', collection: NSID.Profile, rkey: 'self' } });
  } else {
    throw new Error(`${did}: getRecord profile HTTP ${profile.status}`);
  }
  events.push({ kind: 'account', did, account: { active: true } });

  const { results } = await db.prepare('SELECT uri, cid FROM records WHERE did = ?1').bind(did).all<{ uri: string; cid: string }>();
  const have = new Map(results.map((r) => [r.uri, r.cid]));
  let fetched = 0;
  for (const collection of COLLECTIONS) {
    for (const rec of await listRecords(f, doc.pds, did, collection)) {
      fetched++;
      const rkey = rec.uri.split('/').pop()!;
      const uri = `at://${did}/${collection}/${rkey}`;
      const cid = have.get(uri);
      have.delete(uri);
      if (cid === rec.cid) continue; // unchanged: no write, no validation
      events.push({ kind: 'commit', did, commit: { operation: 'create', collection, rkey, cid: rec.cid, record: rec.value } });
    }
  }
  for (const uri of have.keys()) {
    const [, , , collection, rkey] = uri.split('/');
    events.push({ kind: 'commit', did, commit: { operation: 'delete', collection, rkey } });
  }
  return { events, fetched, actor };
}

// Reconciles one repo: applies its events, then its PDS and handle (after
// ingest, which creates the actor's row if it's new).
async function syncRepo(db: D1Database, f: Fetch, did: string): Promise<{ events: number; fetched: number }> {
  const { events, fetched, actor } = await reconcileRepo(db, f, did);
  await ingest(db, events);
  if (actor) await db.prepare('UPDATE actors SET pds = ?1, handle = ?2 WHERE did = ?3').bind(actor.pds, actor.handle, did).run();
  return { events: events.length, fetched };
}

// Starts a pass: the relay's users plus every account already indexed.
async function start(db: D1Database, f: Fetch, now: Date): Promise<string[]> {
  const listed = await listUsers(f);
  const { results } = await db.prepare('SELECT did FROM actors').all<{ did: string }>();
  const queue = [...new Set([...listed, ...results.map((r) => r.did)])];
  const pass: Pass = { started: now.toISOString(), repos: 0, events: 0, errors: [] };
  await db.batch([
    setState(db, QUEUE, JSON.stringify(queue)),
    setState(db, STARTED, JSON.stringify(pass)),
    db.prepare('DELETE FROM state WHERE key = ?1').bind(RECONCILE_REQUESTED),
  ]);
  return queue;
}

export interface SliceResult { started: boolean; repos: number; events: number; remaining: number; finished: boolean }

// One slice: starts a pass if one is due, then works through a few repos.
export async function reconcileSlice(db: D1Database, f: Fetch, now = new Date()): Promise<SliceResult> {
  const res: SliceResult = { started: false, repos: 0, events: 0, remaining: 0, finished: false };
  const queued = await getState(db, QUEUE);
  let queue: string[] | null = queued ? JSON.parse(queued) : null;
  if (!queue) {
    const requested = await getState(db, RECONCILE_REQUESTED);
    const last = await getState(db, LAST);
    const lastStarted = last ? Date.parse((JSON.parse(last) as Pass).started) : 0;
    if (!requested && now.getTime() - lastStarted < EVERY_MS) return newAccounts(db, f, res);
    queue = await start(db, f, now);
    res.started = true;
  }
  const pass = JSON.parse((await getState(db, STARTED)) ?? 'null') as Pass ?? { started: now.toISOString(), repos: 0, events: 0, errors: [] };

  let records = 0;
  while (queue.length && res.repos < REPOS_PER_SLICE && records < RECORDS_PER_SLICE) {
    const did = queue.shift()!;
    res.repos++;
    try {
      const { events, fetched } = await syncRepo(db, f, did);
      records += fetched;
      res.events += events;
    } catch (err) {
      if (pass.errors.length < 50) pass.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  pass.repos += res.repos;
  pass.events += res.events;
  res.remaining = queue.length;
  if (queue.length) {
    await db.batch([setState(db, QUEUE, JSON.stringify(queue)), setState(db, STARTED, JSON.stringify(pass))]);
  } else {
    res.finished = true;
    await db.batch([
      db.prepare('DELETE FROM state WHERE key IN (?1, ?2)').bind(QUEUE, STARTED),
      setState(db, LAST, JSON.stringify({ ...pass, finished: now.toISOString() })),
    ]);
  }
  return res;
}

// Between passes: accounts seen on Jetstream but not yet reconciled (no PDS
// known), so their handle and PDS follow within minutes.
async function newAccounts(db: D1Database, f: Fetch, res: SliceResult): Promise<SliceResult> {
  const { results } = await db.prepare('SELECT did FROM actors WHERE pds IS NULL LIMIT ?1').bind(REPOS_PER_SLICE).all<{ did: string }>();
  for (const { did } of results) {
    res.repos++;
    try {
      res.events += (await syncRepo(db, f, did)).events;
    } catch {
      // Not again until the daily pass: an empty PDS marks it tried.
      await db.prepare("UPDATE actors SET pds = '' WHERE did = ?1 AND pds IS NULL").bind(did).run();
    }
  }
  return res;
}

// Asks for a pass at the next slice; with wipe, empties the index first
// (the hidden list stays), to rebuild it from the network.
export async function requestReconcile(db: D1Database, { wipe = false } = {}, now = new Date()): Promise<void> {
  await db.batch([
    ...(wipe ? [db.prepare('DELETE FROM records'), db.prepare('DELETE FROM actors')] : []),
    db.prepare('DELETE FROM state WHERE key IN (?1, ?2)').bind(QUEUE, STARTED),
    setState(db, RECONCILE_REQUESTED, now.toISOString()),
  ]);
}
