import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getRouteReviews, getRouteStats } from '../src/api';
import { type IndexEvent, ingest } from '../src/ingest';
import { NSID } from '../src/lexicons';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
const KEY = '1E57E06gbDEBBBICDGF.tn3dBnAuR_Q';
const KEY2 = '1EvEh2SgwrCjCrCC_BnEb8BQBe4DmBqCqCb4C_C.AJT-NbwgRVz';
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const BLOB = { $type: 'blob', ref: { $link: 'bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy' }, mimeType: 'application/gzip', size: 1000 };
const NOW = new Date('2026-11-14T12:00:00.000Z');

const ev = (did: string, collection: string, rkey: string, record: Record<string, unknown>): IndexEvent =>
  ({ kind: 'commit', did, commit: { operation: 'create', collection, rkey, cid: CID, record: { $type: collection, ...record } } });
const profile = (did: string) => ev(did, NSID.Profile, 'self', { createdAt: '2026-01-01T00:00:00.000Z' });
const fave = (did: string, key = KEY) => ev(did, NSID.Fave, key, { createdAt: '2026-11-01T00:00:00.000Z' });
const review = (did: string, rkey: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  ev(did, NSID.Review, rkey, { text: `review ${rkey}`, createdAt, routeKey: KEY, ...extra });
const track = (did: string, rkey: string) => ev(did, NSID.Track, rkey, { gpx: BLOB, createdAt: '2026-11-10T00:00:00.000Z', routeKey: KEY, distance: 5000 });

async function seed() {
  await ingest(env.DB, [
    profile(ALICE), profile(BOB),
    fave(ALICE), fave(BOB), fave(CAROL), // Carol has no profile: not counted
    fave(ALICE, KEY2),
    review(ALICE, '3la1', '2026-11-10T00:00:00.000Z', { tags: ['mud', 'views'], hikedAt: '2026-11-09T00:00:00.000Z' }),
    review(BOB, '3la2', '2026-11-12T00:00:00.000Z', { tags: ['snow'] }),
    review(BOB, '3la3', '2026-09-01T00:00:00.000Z', { tags: ['bugs'] }), // too old for recentTags
    track(ALICE, '3lt1'),
  ]);
  await env.DB.prepare("UPDATE actors SET handle = 'alice.example.com', pds = 'https://pds.example.com' WHERE did = ?1").bind(ALICE).run();
}

describe('getRouteStats', () => {
  it('counts each route, with recent tags newest first', async () => {
    await seed();
    expect(await getRouteStats(env.DB, [KEY, KEY2, 'nobody.posted', KEY], NOW)).toEqual({
      routes: [
        { routeKey: KEY, faves: 2, reviews: 3, tracks: 1, lastActivity: '2026-11-12T00:00:00.000Z', recentTags: ['snow', 'mud', 'views'] },
        { routeKey: KEY2, faves: 1, reviews: 0, tracks: 0, lastActivity: '2026-11-01T00:00:00.000Z' },
        { routeKey: 'nobody.posted', faves: 0, reviews: 0, tracks: 0 },
      ],
    });
  });

  it('leaves out hidden records, hidden accounts and inactive accounts', async () => {
    await seed();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO hidden VALUES (?1, 'spam', '')").bind(`at://${BOB}/${NSID.Review}/3la2`),
      env.DB.prepare("INSERT INTO hidden VALUES (?1, 'spam', '')").bind(BOB),
      env.DB.prepare("UPDATE actors SET status = 'takendown' WHERE did = ?1").bind(ALICE),
    ]);
    expect((await getRouteStats(env.DB, [KEY], NOW)).routes[0]).toEqual({ routeKey: KEY, faves: 0, reviews: 0, tracks: 0 });
  });
});

describe('getRouteReviews', () => {
  it('pages newest first, with authors', async () => {
    await seed();
    const p1 = await getRouteReviews(env.DB, KEY, 2);
    expect(p1.reviews.map((r) => (r.record as { text: string }).text)).toEqual(['review 3la2', 'review 3la1']);
    expect(p1.reviews[1].author).toEqual({ did: ALICE, handle: 'alice.example.com', pds: 'https://pds.example.com' });
    expect(p1.reviews[0].author).toEqual({ did: BOB });
    expect(p1.cursor).toBeTruthy();
    const p2 = await getRouteReviews(env.DB, KEY, 2, p1.cursor);
    expect(p2.reviews.map((r) => r.uri)).toEqual([`at://${BOB}/${NSID.Review}/3la3`]);
    expect(p2.cursor).toBeUndefined();
  });
});

describe('/xrpc', () => {
  const get = (path: string, init?: RequestInit) => exports.default.fetch(`https://indexer.test/xrpc/${path}`, init);

  it('answers getRouteStats, with CORS and caching', async () => {
    await seed();
    const r = await get(`com.hikeratlas.temp.getRouteStats?keys=${KEY}&keys=${KEY2}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    expect((await r.json<{ routes: { faves: number }[] }>()).routes.map((x) => x.faves)).toEqual([2, 1]);
  });

  it('answers getRouteTracks', async () => {
    await seed();
    const r = await get(`com.hikeratlas.temp.getRouteTracks?key=${KEY}&limit=5`);
    const body = await r.json<{ tracks: { uri: string; record: { distance: number } }[] }>();
    expect(body.tracks).toHaveLength(1);
    expect(body.tracks[0].record.distance).toBe(5000);
  });

  it('rejects bad parameters, XRPC-style', async () => {
    for (const path of ['com.hikeratlas.temp.getRouteStats', `com.hikeratlas.temp.getRouteReviews?key=${KEY}&limit=500`, `com.hikeratlas.temp.getRouteReviews?key=${KEY}&cursor=zzz`]) {
      const r = await get(path);
      expect(r.status, path).toBe(400);
      expect(await r.json(), path).toMatchObject({ error: 'InvalidRequest' });
    }
  });

  it('501s unknown queries and answers preflights', async () => {
    expect((await get('com.example.nope')).status).toBe(501);
    const pre = await get('com.hikeratlas.temp.getRouteStats', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });
});
