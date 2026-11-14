#!/usr/bin/env node
// Calls the indexer's admin endpoints, with ADMIN_TOKEN from the environment.
//
//     INDEXER=https://indexer.hikeratlas.com ADMIN_TOKEN=... node scripts/admin.mjs hide <at://… | did:…> "<reason, e.g. feedback#12 spam>"
//     ... node scripts/admin.mjs unhide <at://… | did:…>
//     ... node scripts/admin.mjs hidden
//     ... node scripts/admin.mjs reconcile [--wipe]
const [cmd, subject, ...rest] = process.argv.slice(2);
const base = process.env.INDEXER;
const token = process.env.ADMIN_TOKEN;
if (!base || !token || !cmd) {
  console.error('usage: INDEXER=<url> ADMIN_TOKEN=<token> node scripts/admin.mjs hide|unhide|hidden|reconcile ...');
  process.exit(2);
}
const call = async (method, path, body) => {
  const r = await fetch(new URL(path, base), {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  console.log(r.status, JSON.stringify(await r.json(), null, 2));
  if (!r.ok) process.exit(1);
};
if (cmd === 'hide') await call('POST', '/admin/hide', { subject, reason: rest.join(' ') });
else if (cmd === 'unhide') await call('POST', '/admin/unhide', { subject });
else if (cmd === 'hidden') await call('GET', '/admin/hidden');
else if (cmd === 'reconcile') await call('POST', `/admin/reconcile${subject === '--wipe' ? '?wipe=1' : ''}`);
else { console.error(`unknown command ${cmd}`); process.exit(2); }
