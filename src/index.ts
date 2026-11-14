// Hiker Atlas's AT Protocol indexer. Follows Jetstream for
// com.hikeratlas.temp.* records (scheduled, every minute) and answers
// queries about them (fetch). See the README.
import type { Env } from './env';
import { CURSOR, connectWebSocket, recordRun, runJetstream } from './jetstream';
import { LEXICON_REF } from './lexicons';

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return health(env);
    return json({ error: 'NotFound', message: 'No such endpoint' }, 404);
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const r = await runJetstream(env.DB, connectWebSocket);
    await recordRun(env.DB, r);
  },
} satisfies ExportedHandler<Env>;
