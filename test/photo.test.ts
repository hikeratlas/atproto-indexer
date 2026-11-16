import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type IndexEvent, ingest } from '../src/ingest';
import { NSID } from '../src/lexicons';
import { hide } from '../src/moderation';
import { GET_PHOTO, THUMB_SIDE, findPhoto, getPhoto } from '../src/photo';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY = '1E57E06gbDEBBBICDGF.tn3dBnAuR_Q';
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const PHOTO = 'bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy';
const OTHER = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PDS = 'https://pds.example.com';
const REVIEW = `at://${ALICE}/${NSID.Review}/3lph`;

const image = (cid: string) => ({ $type: 'blob', ref: { $link: cid }, mimeType: 'image/jpeg', size: 1_900_000 });
const ev = (rkey: string, record: Record<string, unknown>): IndexEvent =>
  ({ kind: 'commit', did: ALICE, commit: { operation: 'create', collection: NSID.Review, rkey, cid: CID, record: { $type: NSID.Review, ...record } } });

async function seed(pds: string | null = PDS) {
  await ingest(env.DB, [ev('3lph', {
    text: 'Views', createdAt: '2026-11-15T00:00:00.000Z', routeKey: KEY,
    photos: [{ image: image(PHOTO), alt: 'The lake', aspectRatio: { width: 4032, height: 3024 } }],
  })]);
  await env.DB.prepare('UPDATE actors SET pds = ?1 WHERE did = ?2').bind(pds, ALICE).run();
}

// A PDS whose getBlob answers with `type`; records each fetch and its cf options.
function pds(type = 'image/jpeg', status = 200) {
  const calls: { url: string; cf?: RequestInitCfProperties }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit<RequestInitCfProperties>) => {
    const u = new URL(String(input));
    calls.push({ url: u.toString(), cf: init?.cf });
    if (u.host === 'plc.directory') {
      return new Response(JSON.stringify({ alsoKnownAs: [], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] }));
    }
    return new Response('img', { status, headers: { 'content-type': type } });
  }) as typeof fetch;
  return { f, calls };
}

const url = (q: string) => new URL(`https://indexer.example.com/xrpc/${GET_PHOTO}?${q}`);

describe('getPhoto (website#177)', () => {
  it('finds only photos of visible records', async () => {
    await seed();
    expect(await findPhoto(env.DB, ALICE, PHOTO)).toBe(PDS);
    expect(await findPhoto(env.DB, ALICE, OTHER)).toBeUndefined();
    await hide(env.DB, REVIEW, 'test');
    expect(await findPhoto(env.DB, ALICE, PHOTO)).toBeUndefined();
  });

  it('serves a thumbnail through cf.image, and the photo as uploaded', async () => {
    await seed();
    const { f, calls } = pds();
    const thumb = await getPhoto(env.DB, f, url(`did=${ALICE}&cid=${PHOTO}`));
    expect(thumb.status).toBe(200);
    expect(await thumb.text()).toBe('img');
    expect(thumb.headers.get('x-content-type-options')).toBe('nosniff');
    expect(thumb.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
    expect(calls[0].url).toBe(`${PDS}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(ALICE)}&cid=${PHOTO}`);
    expect(calls[0].cf?.image).toMatchObject({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'scale-down', format: 'webp' });
    await getPhoto(env.DB, f, url(`did=${ALICE}&cid=${PHOTO}&size=fullsize`));
    expect(calls[1].cf?.image).toBeUndefined();
  });

  it("resolves the PDS when the account's isn't known yet", async () => {
    await seed(null);
    const { f, calls } = pds();
    expect((await getPhoto(env.DB, f, url(`did=${ALICE}&cid=${PHOTO}`))).status).toBe(200);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['plc.directory', 'pds.example.com']);
  });

  it('refuses what isn\'t an image, an unknown photo, and bad parameters', async () => {
    await seed();
    await expect(getPhoto(env.DB, pds('text/html').f, url(`did=${ALICE}&cid=${PHOTO}`))).rejects.toMatchObject({ status: 502 });
    await expect(getPhoto(env.DB, pds('image/jpeg', 404).f, url(`did=${ALICE}&cid=${PHOTO}`))).rejects.toMatchObject({ status: 502 });
    await expect(getPhoto(env.DB, pds().f, url(`did=${ALICE}&cid=${OTHER}`))).rejects.toMatchObject({ status: 404, error: 'NotFound' });
    await expect(getPhoto(env.DB, pds().f, url(`did=nope&cid=${PHOTO}`))).rejects.toMatchObject({ status: 400 });
    await expect(getPhoto(env.DB, pds().f, url(`did=${ALICE}&cid=${PHOTO}&size=huge`))).rejects.toMatchObject({ status: 400 });
  });

  it('answers a bad request through the Worker with an XRPC error', async () => {
    const r = await exports.default.fetch(`https://indexer.example.com/xrpc/${GET_PHOTO}?did=${ALICE}&cid=${OTHER}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'NotFound' });
  });
});
