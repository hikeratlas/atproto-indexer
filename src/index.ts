// Hiker Atlas's AT Protocol indexer. Follows Jetstream for
// com.hikeratlas.temp.* records (scheduled, every minute) and answers
// queries about them (fetch). See the README.
import { XrpcError, xrpc } from './api';
import type { Env } from './env';
import { CURSOR, connectWebSocket, recordRun, runJetstream } from './jetstream';
import { LEXICON_REF } from './lexicons';
import { reconcileSlice, requestReconcile } from './reconcile';
import { setState } from './state';

export const JETSTREAM_CRON = '* * * * *';
export const RECONCILE_CRON = '*/5 * * * *';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// The data is public, and the lexicons are published for any app: any
// origin may call the API.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' };

async function query(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-headers': '*' } });
  if (req.method !== 'GET') return json({ error: 'InvalidRequest', message: 'GET' }, 405, CORS);
  // The Cache API (on a custom domain) saves D1 reads for popular pages.
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const r = await xrpc(env.DB, url.pathname.slice('/xrpc/'.length), url);
    if (!r) return json({ error: 'MethodNotImplemented', message: 'No such query' }, 501, CORS);
    const resp = json(r.body, 200, { ...CORS, 'cache-control': `public, max-age=${r.maxAge}` });
    ctx.waitUntil(cache.put(req, resp.clone()));
    return resp;
  } catch (err) {
    if (err instanceof XrpcError) return json({ error: err.error, message: err.message }, err.status, CORS);
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
  if (req.method !== 'POST') return json({ error: 'InvalidRequest', message: 'POST' }, 405);
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
