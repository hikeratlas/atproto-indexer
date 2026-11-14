import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Each test starts from an empty index.
beforeEach(async () => {
  await env.DB.batch(['actors', 'records', 'hidden', 'state'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});
