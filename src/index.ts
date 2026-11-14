// Hiker Atlas's AT Protocol indexer. Follows Jetstream for
// com.hikeratlas.temp.* records (scheduled, every minute) and answers
// queries about them (fetch). See the README.
import type { Env } from './env';
import { CURSOR, connectWebSocket, recordRun, runJetstream } from './jetstream';
import { LEXICON_REF } from './lexicons';
import { reconcileSlice, requestReconcile } from './reconcile';
import { setState } from './state';

export const JETSTREAM_CRON = '* * * * *';
export const RECONCILE_CRON = '*/5 * * * *';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
