// Hiker Atlas's AT Protocol indexer. Follows Jetstream for
// com.hikeratlas.temp.* records (scheduled, every minute) and answers
// queries about them (fetch). See the README.
import type { Env } from './env';
import { LEXICON_REF } from './lexicons';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const { results } = await env.DB.prepare('SELECT key, value FROM state').all<{ key: string; value: string }>();
      return json({ lexicons: LEXICON_REF, state: Object.fromEntries(results.map((r) => [r.key, r.value])) });
    }
    return json({ error: 'NotFound', message: 'No such endpoint' }, 404);
  },

  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // The Jetstream consumer (#3).
  },
} satisfies ExportedHandler<Env>;
