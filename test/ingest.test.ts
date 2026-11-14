import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type IndexEvent, ingest } from '../src/ingest';
import { NSID } from '../src/lexicons';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const KEY = '1E57E06gbDEBBBICDGF.tn3dBnAuR_Q';
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const NOW = '2026-11-14T12:00:00.000Z';
const at = '2026-11-01T10:00:00.000Z';

const commit = (did: string, collection: string, rkey: string, record?: Record<string, unknown>, operation: 'create' | 'update' | 'delete' = 'create'): IndexEvent => ({
  kind: 'commit', did, commit: { operation, collection, rkey, ...(operation === 'delete' ? {} : { cid: CID, record: { $type: collection, ...record } }) },
});
const profile = (did: string) => commit(did, NSID.Profile, 'self', { createdAt: at });
const fave = (did: string, key = KEY) => commit(did, NSID.Fave, key, { createdAt: at });
const review = (did: string, rkey: string, extra: Record<string, unknown> = {}, operation: 'create' | 'update' = 'create') =>
  commit(did, NSID.Review, rkey, { text: 'Lovely', createdAt: at, routeKey: KEY, tags: ['views'], ...extra }, operation);

async function dump() {
  const actors = (await env.DB.prepare('SELECT did, handle, has_profile, status FROM actors ORDER BY did').all()).results;
  const records = (await env.DB.prepare('SELECT uri, collection, route_key, cell, created_at, json FROM records ORDER BY uri').all()).results;
  return { actors, records };
}

describe('ingest', () => {
  it('stores faves, reviews and profiles', async () => {
    const stats = await ingest(env.DB, [profile(ALICE), fave(ALICE), review(ALICE, '3lbxyz')], NOW);
    expect(stats).toEqual({ applied: 3, skipped: {} });
    const { actors, records } = await dump();
    expect(actors).toEqual([{ did: ALICE, handle: null, has_profile: 1, status: 'active' }]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ uri: `at://${ALICE}/${NSID.Fave}/${KEY}`, route_key: KEY, created_at: at });
    expect(records[0].cell).toMatch(/^8a[0-9a-f]{13}$/);
    expect(records[1]).toMatchObject({ collection: NSID.Review, route_key: KEY });
    expect(JSON.parse(records[1].json as string)).toMatchObject({ text: 'Lovely' });
  });

  it('gives the same database when events are applied twice', async () => {
    const events = [profile(ALICE), fave(ALICE), review(ALICE, '3lbxyz'), commit(ALICE, NSID.Review, '3lbxyz', {}, 'delete'), fave(BOB)];
    await ingest(env.DB, events, NOW);
    const once = await dump();
    await ingest(env.DB, events, NOW);
    expect(await dump()).toEqual(once);
    expect(once.records.map((r) => r.collection)).toEqual([NSID.Fave, NSID.Fave]);
  });

  it('replaces a record on update', async () => {
    await ingest(env.DB, [review(ALICE, '3lbxyz')], NOW);
    await ingest(env.DB, [review(ALICE, '3lbxyz', { text: 'Muddy' }, 'update')], NOW);
    const { records } = await dump();
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0].json as string).text).toBe('Muddy');
  });

  it('keeps a track or review without a route key, unattached', async () => {
    await ingest(env.DB, [review(ALICE, '3lbxyz', { routeKey: undefined })], NOW);
    const { records } = await dump();
    expect(records).toMatchObject([{ route_key: null, cell: null }]);
  });

  it('skips what is invalid', async () => {
    const stats = await ingest(env.DB, [
      fave(ALICE, 'not-a-route-key'),
      review(ALICE, '3lbaaa', { routeKey: 'nope.nope' }),
      review(ALICE, '3lbbbb', { text: undefined }), // text is required
      commit(ALICE, NSID.Review, '3lbcccc', { text: 'x' }), // no createdAt
      { kind: 'commit', did: ALICE, commit: { operation: 'create', collection: NSID.Fave, rkey: KEY, record: { $type: NSID.Fave, createdAt: at } } }, // no cid
      { kind: 'commit', did: ALICE, commit: { operation: 'create', collection: NSID.Fave, rkey: KEY, cid: CID, record: { $type: NSID.Review, createdAt: at } } }, // wrong $type
      commit(ALICE, NSID.Profile, 'other', { createdAt: at }),
      commit(ALICE, 'app.bsky.feed.post', '3lbdddd', { text: 'hi', createdAt: at }),
      fave('did:example:nope'),
    ], NOW);
    expect(stats.applied).toBe(0);
    expect(stats.skipped).toEqual({
      'bad-route-key': 2, invalid: 2, 'no-cid': 1, 'wrong-type': 1, 'bad-rkey': 1, 'other-collection': 1, 'bad-did': 1,
    });
    expect(await dump()).toEqual({ actors: [], records: [] });
  });

  it('clears has_profile when the profile is deleted', async () => {
    await ingest(env.DB, [profile(ALICE), fave(ALICE)], NOW);
    await ingest(env.DB, [commit(ALICE, NSID.Profile, 'self', undefined, 'delete')], NOW);
    const { actors, records } = await dump();
    expect(actors).toMatchObject([{ has_profile: 0 }]);
    expect(records).toHaveLength(1);
  });

  it('applies account and identity events to known accounts only', async () => {
    await ingest(env.DB, [profile(ALICE)], NOW);
    await ingest(env.DB, [
      { kind: 'identity', did: ALICE, identity: { handle: 'Alice.example.com' } },
      { kind: 'account', did: ALICE, account: { active: false, status: 'takendown' } },
      { kind: 'identity', did: BOB, identity: { handle: 'bob.example.com' } },
      { kind: 'account', did: BOB, account: { active: false, status: 'deactivated' } },
    ], NOW);
    expect((await dump()).actors).toEqual([{ did: ALICE, handle: 'alice.example.com', has_profile: 1, status: 'takendown' }]);
    await ingest(env.DB, [{ kind: 'account', did: ALICE, account: { active: true } }], NOW);
    expect((await dump()).actors).toMatchObject([{ status: 'active' }]);
  });

  it('forgets a deleted account', async () => {
    await ingest(env.DB, [profile(ALICE), fave(ALICE), profile(BOB), fave(BOB)], NOW);
    await ingest(env.DB, [{ kind: 'account', did: ALICE, account: { active: false, status: 'deleted' } }], NOW);
    const { actors, records } = await dump();
    expect(actors.map((a) => a.did)).toEqual([BOB]);
    expect(records.map((r) => (r.uri as string).split('/')[2])).toEqual([BOB]);
  });
});
