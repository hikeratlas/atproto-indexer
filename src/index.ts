// Hiker Atlas's AT Protocol indexer. Follows Jetstream for
// com.hikeratlas.temp.* records (scheduled, every minute) and answers
// queries about them (fetch). See the README.
import { XrpcError, xrpc } from './api';
import type { Env } from './env';
import { CURSOR, connectWebSocket, recordRun, runJetstream } from './jetstream';
import { LEXICON_REF } from './lexicons';
import { hide, listHidden, unhide, validSubject } from './moderation';
import { notify } from './notify';
import { reconcileSlice, requestReconcile } from './reconcile';
import { setState } from './state';

export const JETSTREAM_CRON = '* * * * *';
export const RECONCILE_CRON = '*/5 * * * *';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// Only Hiker Atlas's own site may call the API from a browser (anyone is
// free to run their own indexer), plus local development.
const ORIGINS = new Set(['https://www.hikeratlas.com']);
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !(ORIGINS.has(origin) || LOCAL.test(origin))) return { vary: 'Origin' };
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400', vary: 'Origin' };
}

// Adds the request's CORS headers to a response (cached ones are stored
// without, so one origin's headers never reach another).
function withCors(resp: Response, req: Request): Response {
  const out = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
  return out;
}

async function query(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'access-control-allow-headers': '*' } });
  if (req.method !== 'GET') return json({ error: 'InvalidRequest', message: 'GET' }, 405, cors(req));
  // The Cache API (on a custom domain) saves D1 reads for popular pages. It's
  // keyed by URL alone, so entries carry no CORS headers.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit, req);
  try {
    const r = await xrpc(env.DB, url.pathname.slice('/xrpc/'.length), url);
    if (!r) return json({ error: 'MethodNotImplemented', message: 'No such query' }, 501, cors(req));
    const resp = json(r.body, 200, { 'cache-control': `public, max-age=${r.maxAge}` });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return withCors(resp, req);
  } catch (err) {
    if (err instanceof XrpcError) return json({ error: err.error, message: err.message }, err.status, cors(req));
    throw err;
  }
}

async function health(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT key, value FROM state').all<{ key: string; value: string }>();
  const state = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const cursor = state[CURSOR] ? Number(state[CURSOR]) : null;
  const lastRun = state['jetstream.lastRun'] ? JSON.parse(state['jetstream.lastRun']) : null;
  return json({
    lexicons: LEXICON_REF,
    // Seconds behind: how old the cursor is.
    lagSeconds: cursor === null ? null : Math.round((Date.now() * 1000 - cursor) / 1e6),
    lastRun,
    state,
  });
}

// Constant-time, so the token can't be guessed a character at a time.
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function admin(req: Request, url: URL, env: Env): Promise<Response> {
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!env.ADMIN_TOKEN || !sameToken(token, env.ADMIN_TOKEN)) return json({ error: 'NotFound', message: 'No such endpoint' }, 404);
  if (url.pathname === '/admin/hidden' && req.method === 'GET') return json({ hidden: await listHidden(env.DB) });
  if (req.method !== 'POST') return json({ error: 'InvalidRequest', message: 'POST' }, 405);
  if (url.pathname === '/admin/hide' || url.pathname === '/admin/unhide') {
    const body = await req.json<{ subject?: string; reason?: string }>().catch(() => ({} as { subject?: string; reason?: string }));
    const subject = body.subject?.trim() ?? '';
    if (!validSubject(subject)) return json({ error: 'InvalidRequest', message: 'subject must be an at:// URI or a DID' }, 400);
    if (url.pathname === '/admin/unhide') return json({ subject, unhidden: await unhide(env.DB, subject) });
    if (!body.reason?.trim()) return json({ error: 'InvalidRequest', message: 'reason is required' }, 400);
    await hide(env.DB, subject, body.reason.trim());
    return json({ subject, hidden: true });
  }
  if (url.pathname === '/admin/reconcile') {
    // ?wipe=1 empties the index first, to rebuild it from the network.
    const wipe = url.searchParams.get('wipe') === '1';
    await requestReconcile(env.DB, { wipe });
    return json({ requested: true, wipe });
  }
  return json({ error: 'NotFound', message: 'No such endpoint' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/xrpc/')) return query(req, url, env, ctx);
    if (url.pathname === '/health') return health(env);
    if (url.pathname === '/notify') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
      if (req.method !== 'POST') return json({ error: 'InvalidRequest', message: 'POST' }, 405, cors(req));
      const body = await req.json<{ uri?: unknown }>().catch(() => ({} as { uri?: unknown }));
      const r = await notify(env.DB, fetch, body.uri);
      return json(r.body, r.status, cors(req));
    }
    if (url.pathname.startsWith('/admin/')) return admin(req, url, env);
    return json({ error: 'NotFound', message: 'No such endpoint' }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === RECONCILE_CRON) {
      const r = await reconcileSlice(env.DB, fetch);
      if (r.repos || r.started) await setState(env.DB, 'reconcile.lastSlice', JSON.stringify({ at: new Date().toISOString(), ...r })).run();
      return;
    }
    const r = await runJetstream(env.DB, connectWebSocket);
    await recordRun(env.DB, r);
  },
} satisfies ExportedHandler<Env>;
