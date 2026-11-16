// com.hikeratlas.temp.getPhoto: a photo of a track or review
// (com.hikeratlas.temp.defs#photo) as an image, for the website and the
// Android app (website#177). Pages showed every photo full size (up to 2 MB)
// straight from its author's PDS; this serves a thumbnail, or the photo as
// uploaded, through Cloudflare's cache, as an AppView's image CDN does for its
// records' blobs.
//
// Only photos of records the indexer has and shows (VISIBLE: an active
// account, neither it nor the record hidden), so it's no open image proxy, and
// a photo hidden after a report stops being served once the cache lets go of it
// (CACHE_SECONDS). The thumbnail is made by Cloudflare's image transformations
// (cf.image), which must be enabled on the zone; the photo as uploaded is
// passed through.
import { VISIBLE } from './api';
import { NSID } from './lexicons';
import { resolveDid } from './reconcile';

type Fetch = typeof fetch;

export const GET_PHOTO = 'com.hikeratlas.temp.getPhoto';
export const SIZES = ['thumbnail', 'fullsize'] as const;
export type Size = (typeof SIZES)[number];
// A thumbnail's longest side, in pixels: sharp in a ~320 px tile on a 2x
// screen.
export const THUMB_SIDE = 640;
// How long a served image is kept (by browsers and the edge): a hidden photo
// is gone from everywhere within this.
export const CACHE_SECONDS = 3600;

const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%:-]+)$/;
// A blob's CID: CIDv1, base32 (b...).
const CID = /^b[a-z2-7]{50,100}$/;

export class PhotoError extends Error {
  constructor(public status: number, public error: string, message: string) { super(message); }
}

export function photoParams(url: URL): { did: string; cid: string; size: Size } {
  const did = url.searchParams.get('did') ?? '';
  const cid = url.searchParams.get('cid') ?? '';
  const size = (url.searchParams.get('size') ?? 'thumbnail') as Size;
  if (!DID.test(did)) throw new PhotoError(400, 'InvalidRequest', 'did must be a DID');
  if (!CID.test(cid)) throw new PhotoError(400, 'InvalidRequest', 'cid must be a blob CID');
  if (!SIZES.includes(size)) throw new PhotoError(400, 'InvalidRequest', `size must be one of ${SIZES.join(', ')}`);
  return { did, cid, size };
}

// The author's PDS, if cid is a photo of one of their visible tracks or
// reviews; undefined if it isn't; null if it is but the PDS isn't known yet.
export async function findPhoto(db: D1Database, did: string, cid: string): Promise<string | null | undefined> {
  const row = await db.prepare(
    `SELECT a.pds FROM records r JOIN actors a ON a.did = r.did
     WHERE r.did = ?1 AND r.collection IN (?3, ?4) AND ${VISIBLE}
       AND EXISTS (SELECT 1 FROM json_each(r.json, '$.photos') p
                   WHERE json_extract(p.value, '$.image.ref."$link"') = ?2)
     LIMIT 1`,
  ).bind(did, cid, NSID.Track, NSID.Review).first<{ pds: string | null }>();
  return row ? row.pds : undefined;
}

// The image, from the PDS: the thumbnail made by cf.image, or the blob.
export async function getPhoto(db: D1Database, f: Fetch, url: URL): Promise<Response> {
  const { did, cid, size } = photoParams(url);
  let pds = await findPhoto(db, did, cid);
  if (pds === undefined) throw new PhotoError(404, 'NotFound', 'No such photo');
  if (!pds) {
    pds = (await resolveDid(f, did))?.pds ?? null;
    if (!pds) throw new PhotoError(502, 'UpstreamFailure', "Can't resolve the account's PDS");
  }
  const blob = new URL('/xrpc/com.atproto.sync.getBlob', pds);
  blob.searchParams.set('did', did);
  blob.searchParams.set('cid', cid);
  const cf: RequestInitCfProperties = { cacheTtl: CACHE_SECONDS, cacheEverything: true };
  if (size === 'thumbnail') {
    cf.image = { width: THUMB_SIDE, height: THUMB_SIDE, fit: 'scale-down', format: 'webp', quality: 80 };
  }
  const up = await f(blob.toString(), { cf });
  const type = up.headers.get('content-type') ?? '';
  if (!up.ok) throw new PhotoError(502, 'UpstreamFailure', `The PDS answered ${up.status}`);
  // Served from the indexer's own origin: never anything but an image.
  if (!/^image\/(jpeg|png|webp|avif|gif)\b/.test(type)) throw new PhotoError(502, 'UpstreamFailure', 'Not an image');
  return new Response(up.body, {
    headers: {
      'content-type': type,
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
}
