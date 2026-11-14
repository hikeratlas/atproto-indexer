import { exports, env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LEXICON_REF } from '../src/lexicons';

describe('/health', () => {
  it('reports the lexicons and state', async () => {
    const cursor = (Date.now() - 90_000) * 1000;
    await env.DB.prepare("INSERT INTO state (key, value) VALUES ('jetstream.cursor', ?1)").bind(String(cursor)).run();
    const r = await exports.default.fetch('https://indexer.test/health');
    expect(r.status).toBe(200);
    const body = await r.json<{ lexicons: string; lagSeconds: number; lastRun: unknown }>();
    expect(body).toMatchObject({ lexicons: LEXICON_REF, lastRun: null });
    expect(body.lagSeconds).toBeGreaterThanOrEqual(89);
    expect(body.lagSeconds).toBeLessThan(120);
  });

  it('404s anything else, XRPC-style', async () => {
    const r = await exports.default.fetch('https://indexer.test/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'NotFound' });
  });
});
