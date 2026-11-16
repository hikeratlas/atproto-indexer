// The query API (#5): XRPC queries defined in hikeratlas/atproto-lexicon,
// answered from D1. Every query leaves out hidden records and accounts
// (#6) and accounts that aren't active; faves count only from accounts
// with a Hiker Atlas profile.
import { Lexicons } from '@atproto/lexicon';
import {
  type ActorView, type GetRouteReviewsOutput, type GetRouteStatsOutput, type GetRouteTracksOutput,
  LEXICONS, NSID, QUERY, type ReviewView, type RouteStats,
} from './lexicons';

const lexicons = new Lexicons(LEXICONS);

export class XrpcError extends Error {
  constructor(public status: number, public error: string, message: string) { super(message); }
}

// Rows shown: from active accounts, and neither they nor the record hidden.
export const VISIBLE = `a.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.subject = r.uri OR h.subject = r.did)`;
const RECENT_DAYS = 30;

export async function getRouteStats(db: D1Database, keys: string[], now = new Date()): Promise<GetRouteStatsOutput> {
  const want = [...new Set(keys)];
  const json = JSON.stringify(want);
  const counts = db.prepare(
    `SELECT r.route_key AS key, r.collection, COUNT(*) AS n, MAX(r.created_at) AS last
     FROM records r JOIN actors a ON a.did = r.did
     WHERE r.route_key IN (SELECT value FROM json_each(?1)) AND ${VISIBLE}
       AND (r.collection != ?2 OR a.has_profile = 1)
     GROUP BY r.route_key, r.collection`,
  ).bind(json, NSID.Fave);
  const since = new Date(now.getTime() - RECENT_DAYS * 86400_000).toISOString();
  const tags = db.prepare(
    `SELECT r.route_key AS key, t.value AS tag, MAX(COALESCE(json_extract(r.json, '$.hikedAt'), r.created_at)) AS at
     FROM records r JOIN actors a ON a.did = r.did, json_each(r.json, '$.tags') t
     WHERE r.route_key IN (SELECT value FROM json_each(?1)) AND r.collection = ?2 AND ${VISIBLE}
       AND COALESCE(json_extract(r.json, '$.hikedAt'), r.created_at) >= ?3
     GROUP BY r.route_key, t.value
     ORDER BY at DESC`,
  ).bind(json, NSID.Review, since);
  const [c, t] = await db.batch<{ key: string; collection?: string; n?: number; last?: string; tag?: string; at?: string }>([counts, tags]);

  const out = new Map<string, RouteStats>(want.map((k) => [k, { routeKey: k, faves: 0, reviews: 0, tracks: 0 }]));
  for (const row of c.results) {
    const s = out.get(row.key)!;
    if (row.collection === NSID.Fave) s.faves = row.n!;
    else if (row.collection === NSID.Review) s.reviews = row.n!;
    else if (row.collection === NSID.Track) s.tracks = row.n!;
    if (!s.lastActivity || row.last! > s.lastActivity) s.lastActivity = row.last!;
  }
  for (const row of t.results) {
    const s = out.get(row.key)!;
    if (typeof row.tag !== 'string') continue;
    if ((s.recentTags ??= []).length < 20) s.recentTags.push(row.tag);
  }
  return { routes: [...out.values()] };
}

// Pages are newest first; a cursor is the last row's createdAt and URI.
function encodeCursor(createdAt: string, uri: string) {
  return btoa(JSON.stringify([createdAt, uri])).replace(/=+$/, '');
}
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(atob(cursor));
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string')) return v as [string, string];
  } catch { /* below */ }
  throw new XrpcError(400, 'InvalidRequest', 'Bad cursor');
}

interface Row { uri: string; cid: string; did: string; handle: string | null; pds: string | null; json: string; created_at: string; indexed_at: string }

async function listByRoute(db: D1Database, collection: string, key: string, limit: number, cursor?: string): Promise<{ items: ReviewView[]; cursor?: string }> {
  const [cAt, cUri] = cursor ? decodeCursor(cursor) : [null, null];
  const { results } = await db.prepare(
    `SELECT r.uri, r.cid, r.did, a.handle, a.pds, r.json, r.created_at, r.indexed_at
     FROM records r JOIN actors a ON a.did = r.did
     WHERE r.route_key = ?1 AND r.collection = ?2 AND ${VISIBLE}
       AND (?3 IS NULL OR r.created_at < ?3 OR (r.created_at = ?3 AND r.uri < ?4))
     ORDER BY r.created_at DESC, r.uri DESC
     LIMIT ?5`,
  ).bind(key, collection, cAt, cUri, limit + 1).all<Row>();
  const more = results.length > limit;
  const page = results.slice(0, limit);
  const items = page.map((row) => {
    // The PDS and handle come from the reconcile (#4), within minutes of an
    // account's first record.
    const author: ActorView = { did: row.did, ...(row.pds ? { pds: row.pds } : {}), ...(row.handle ? { handle: row.handle } : {}) };
    return { uri: row.uri, cid: row.cid, author, record: JSON.parse(row.json), indexedAt: row.indexed_at };
  });
  const last = page.at(-1);
  return { items, ...(more && last ? { cursor: encodeCursor(last.created_at, last.uri) } : {}) };
}

export async function getRouteReviews(db: D1Database, key: string, limit = 20, cursor?: string): Promise<GetRouteReviewsOutput> {
  const { items, cursor: next } = await listByRoute(db, NSID.Review, key, limit, cursor);
  return { reviews: items, ...(next ? { cursor: next } : {}) };
}

export async function getRouteTracks(db: D1Database, key: string, limit = 20, cursor?: string): Promise<GetRouteTracksOutput> {
  const { items, cursor: next } = await listByRoute(db, NSID.Track, key, limit, cursor);
  return { tracks: items, ...(next ? { cursor: next } : {}) };
}

// A query's parameters from the URL, as its lexicon types them.
function params(nsid: string, url: URL): Record<string, unknown> {
  const def = lexicons.getDefOrThrow(nsid) as { parameters?: { properties?: Record<string, { type: string }> } };
  const props = def.parameters?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props)) {
    const all = url.searchParams.getAll(name);
    if (!all.length) continue;
    if (p.type === 'array') out[name] = all;
    else if (p.type === 'integer') out[name] = Number(all[0]);
    else if (p.type === 'boolean') out[name] = all[0] === 'true';
    else out[name] = all[0];
  }
  try {
    return lexicons.assertValidXrpcParams(nsid, out) as Record<string, unknown>;
  } catch (err) {
    throw new XrpcError(400, 'InvalidRequest', err instanceof Error ? err.message : String(err));
  }
}

const CACHE_SECONDS: Record<string, number> = {
  [QUERY.GetRouteStats]: 60,
  [QUERY.GetRouteReviews]: 60,
  [QUERY.GetRouteTracks]: 60,
};

// Answers /xrpc/<nsid>, or null if it isn't one of ours.
export async function xrpc(db: D1Database, nsid: string, url: URL): Promise<{ body: unknown; maxAge: number } | null> {
  let body: unknown;
  switch (nsid) {
    case QUERY.GetRouteStats: {
      const p = params(nsid, url) as { keys: string[] };
      body = await getRouteStats(db, p.keys);
      break;
    }
    case QUERY.GetRouteReviews: {
      const p = params(nsid, url) as { key: string; limit?: number; cursor?: string };
      body = await getRouteReviews(db, p.key, p.limit ?? 20, p.cursor);
      break;
    }
    case QUERY.GetRouteTracks: {
      const p = params(nsid, url) as { key: string; limit?: number; cursor?: string };
      body = await getRouteTracks(db, p.key, p.limit ?? 20, p.cursor);
      break;
    }
    default:
      return null;
  }
  return { body, maxAge: CACHE_SECONDS[nsid] };
}
