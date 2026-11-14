import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/ingest';
import { RECONCILE_REQUESTED } from '../src/jetstream';
import { NSID } from '../src/lexicons';
import { LAST, QUEUE, REPOS_PER_SLICE, reconcileSlice, requestReconcile } from '../src/reconcile';
import { getState } from '../src/state';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const KEY = '1E57E06gbDEBBBICDGF.tn3dBnAuR_Q';
const KEY2 = '1EvEh2SgwrCjCrCC_BnEb8BQBe4DmBqCqCb4C_C.AJT-NbwgRVz';
const CID1 = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const CID2 = 'bafyreias3gj55kv5yhvjzmphybat3kddqutnbrfqbr6hrkxtma66u6vkme';
const PDS = 'https://pds.example.com';
const at = '2026-11-01T10:00:00.000Z';
const NOW = new Date('2026-11-14T12:00:00.000Z');

interface Repo { status?: { active: boolean; status?: string } | 'missing'; handle?: string; handleResolves?: boolean; profile?: boolean; records?: Record<string, { rkey: string; cid: string; value: Record<string, unknown> }[]> }

// A fake network: the relay, plc.directory, the handle resolver and one PDS.
function network(users: string[], repos: Record<string, Repo>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(`${u.host}${u.pathname}`);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const err = (status: number, error: string) => new Response(JSON.stringify({ error, message: error }), { status });
    if (u.pathname.endsWith('listReposByCollection')) return ok({ repos: users.map((did) => ({ did })) });
    if (u.host === 'plc.directory') {
      const did = u.pathname.slice(1), repo = repos[did];
      if (!repo) return err(404, 'NotFound');
      return ok({ id: did, alsoKnownAs: repo.handle ? [`at://${repo.handle}`] : [], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    }
    if (u.pathname.endsWith('resolveHandle')) {
      const h = u.searchParams.get('handle');
      const did = Object.entries(repos).find(([, r]) => r.handle === h && r.handleResolves !== false)?.[0];
      return did ? ok({ did }) : err(400, 'InvalidRequest');
    }
    const did = u.searchParams.get('did') ?? u.searchParams.get('repo')!, repo = repos[did];
    if (u.pathname.endsWith('getRepoStatus')) {
      if (!repo || repo.status === 'missing') return err(400, 'RepoNotFound');
      return ok({ did, ...(repo.status ?? { active: true }) });
    }
    if (u.pathname.endsWith('getRecord')) {
      return repo.profile === false ? err(400, 'RecordNotFound') : ok({ uri: `at://${did}/${NSID.Profile}/self`, cid: CID1, value: { $type: NSID.Profile, createdAt: at } });
    }
    if (u.pathname.endsWith('listRecords')) {
      const c = u.searchParams.get('collection')!;
      return ok({ records: (repo.records?.[c] ?? []).map((r) => ({ uri: `at://${did}/${c}/${r.rkey}`, cid: r.cid, value: { $type: c, ...r.value } })) });
    }
    return err(404, 'NotFound');
  }) as typeof fetch;
  return { f, calls };
}

const rows = async () => (await env.DB.prepare('SELECT uri, cid FROM records ORDER BY uri').all<{ uri: string; cid: string }>()).results;
const actors = async () => (await env.DB.prepare('SELECT did, handle, pds, has_profile, status FROM actors ORDER BY did').all()).results;
const fave = (did: string, key: string, cid = CID1) => ({ kind: 'commit' as const, did, commit: { operation: 'create' as const, collection: NSID.Fave, rkey: key, cid, record: { $type: NSID.Fave, createdAt: at } } });

describe('reconcileSlice', () => {
  it('does nothing when no pass is due', async () => {
    await env.DB.prepare('INSERT INTO state (key, value) VALUES (?1, ?2)').bind(LAST, JSON.stringify({ started: new Date(NOW.getTime() - 3600_000).toISOString() })).run();
    const { f, calls } = network([], {});
    expect(await reconcileSlice(env.DB, f, NOW)).toMatchObject({ started: false, repos: 0 });
    expect(calls).toEqual([]);
  });

  it('brings the index in line with each PDS', async () => {
    // Indexed already: one of Alice's faves (unchanged), a review she has
    // since deleted, and Bob, whose account is gone.
    await ingest(env.DB, [
      fave(ALICE, KEY),
      { kind: 'commit', did: ALICE, commit: { operation: 'create', collection: NSID.Review, rkey: '3lbgone', cid: CID1, record: { $type: NSID.Review, text: 'x', createdAt: at } } },
      fave(BOB, KEY),
    ]);
    const { f } = network([ALICE], {
      [ALICE]: { handle: 'alice.example.com', records: { [NSID.Fave]: [{ rkey: KEY, cid: CID1, value: { createdAt: at } }, { rkey: KEY2, cid: CID2, value: { createdAt: at } }] } },
      [BOB]: { status: 'missing' },
    });
    const r = await reconcileSlice(env.DB, f, NOW);
    expect(r).toMatchObject({ started: true, repos: 2, finished: true, remaining: 0 });
    expect(await rows()).toEqual([
      { uri: `at://${ALICE}/${NSID.Fave}/${KEY}`, cid: CID1 },
      { uri: `at://${ALICE}/${NSID.Fave}/${KEY2}`, cid: CID2 },
    ]);
    expect(await actors()).toEqual([{ did: ALICE, handle: 'alice.example.com', pds: PDS, has_profile: 1, status: 'active' }]);
    expect(JSON.parse((await getState(env.DB, LAST))!)).toMatchObject({ repos: 2, errors: [], finished: NOW.toISOString() });
    expect(await getState(env.DB, QUEUE)).toBeNull();
  });

  it('records a deactivated account, and an unverified handle as none', async () => {
    await ingest(env.DB, [fave(ALICE, KEY)]);
    const { f } = network([ALICE], { [ALICE]: { handle: 'liar.example.com', handleResolves: false, status: { active: false, status: 'deactivated' } } });
    await reconcileSlice(env.DB, f, NOW);
    expect(await actors()).toEqual([{ did: ALICE, handle: null, pds: PDS, has_profile: 0, status: 'deactivated' }]);
    expect(await rows()).toHaveLength(1); // kept, but not shown while inactive
  });

  it('works through the queue a few repos at a time', async () => {
    const users = Array.from({ length: REPOS_PER_SLICE + 2 }, (_, i) => `did:plc:${String.fromCharCode(99 + i).repeat(24)}`);
    const { f } = network(users, Object.fromEntries(users.map((d) => [d, { records: { [NSID.Fave]: [{ rkey: KEY, cid: CID1, value: { createdAt: at } }] } }])));
    expect(await reconcileSlice(env.DB, f, NOW)).toMatchObject({ started: true, repos: REPOS_PER_SLICE, remaining: 2, finished: false });
    expect(await reconcileSlice(env.DB, f, NOW)).toMatchObject({ started: false, repos: 2, remaining: 0, finished: true });
    expect(await rows()).toHaveLength(users.length);
    // Done for the day.
    expect(await reconcileSlice(env.DB, f, NOW)).toMatchObject({ started: false, repos: 0 });
  });

  it('starts early when asked, and can rebuild from empty', async () => {
    await env.DB.prepare('INSERT INTO state (key, value) VALUES (?1, ?2)').bind(LAST, JSON.stringify({ started: NOW.toISOString() })).run();
    await ingest(env.DB, [fave(BOB, KEY)]);
    await requestReconcile(env.DB, { wipe: true }, NOW);
    expect(await rows()).toEqual([]);
    const { f } = network([ALICE], { [ALICE]: { records: { [NSID.Fave]: [{ rkey: KEY, cid: CID1, value: { createdAt: at } }] } } });
    expect(await reconcileSlice(env.DB, f, NOW)).toMatchObject({ started: true, finished: true });
    expect((await rows()).map((r) => r.uri)).toEqual([`at://${ALICE}/${NSID.Fave}/${KEY}`]);
    expect(await getState(env.DB, RECONCILE_REQUESTED)).toBeNull();
  });

  it('keeps going past a repo that fails', async () => {
    const { f } = network([BOB, ALICE], { [ALICE]: { records: { [NSID.Fave]: [{ rkey: KEY, cid: CID1, value: { createdAt: at } }] } } });
    const r = await reconcileSlice(env.DB, f, NOW);
    expect(r).toMatchObject({ repos: 2, finished: true });
    expect(await rows()).toHaveLength(1);
    expect(JSON.parse((await getState(env.DB, LAST))!).errors).toEqual([`${BOB}: can't resolve`]);
  });
});

describe('/admin/reconcile', () => {
  it('is hidden without the token', async () => {
    const r = await exports.default.fetch('https://indexer.test/admin/reconcile', { method: 'POST', headers: { authorization: 'Bearer wrong' } });
    expect(r.status).toBe(404);
  });

  it('requests a pass', async () => {
    const r = await exports.default.fetch('https://indexer.test/admin/reconcile', { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    expect(await r.json()).toEqual({ requested: true, wipe: false });
    expect(await getState(env.DB, RECONCILE_REQUESTED)).not.toBeNull();
  });
});

describe('new accounts between passes', () => {
  it('get their PDS and handle at the next slice', async () => {
    await env.DB.prepare('INSERT INTO state (key, value) VALUES (?1, ?2)').bind(LAST, JSON.stringify({ started: NOW.toISOString() })).run();
    await ingest(env.DB, [fave(ALICE, KEY), fave(BOB, KEY)]);
    const { f } = network([], { [ALICE]: { handle: 'alice.example.com', records: { [NSID.Fave]: [{ rkey: KEY, cid: CID1, value: { createdAt: at } }] } } });
    expect(await reconcileSlice(env.DB, f, NOW)).toMatchObject({ started: false, repos: 2 });
    expect(await actors()).toMatchObject([
      { did: ALICE, handle: 'alice.example.com', pds: PDS, has_profile: 1 },
      { did: BOB, pds: '' }, // unresolvable: not retried until the daily pass
    ]);
    expect(await reconcileSlice(env.DB, f, NOW)).toMatchObject({ repos: 0 });
  });
});
