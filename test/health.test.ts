import { exports, env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { LEXICON_REF } from '../src/lexicons';

describe('/health', () => {
  it('reports the lexicons and state', async () => {
    await env.DB.prepare("INSERT INTO state (key, value) VALUES ('cursor', '123')").run();
    const r = await exports.default.fetch('https://indexer.test/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ lexicons: LEXICON_REF, state: { cursor: '123' } });
  });

  it('404s anything else, XRPC-style', async () => {
    const r = await exports.default.fetch('https://indexer.test/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'NotFound' });
  });
});
