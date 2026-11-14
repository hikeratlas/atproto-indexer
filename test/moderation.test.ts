import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getRouteReviews, getRouteStats } from '../src/api';
import { ingest } from '../src/ingest';
import { NSID } from '../src/lexicons';
import { validSubject } from '../src/moderation';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY = '1E57E06gbDEBBBICDGF.tn3dBnAuR_Q';
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const URI = `at://${ALICE}/${NSID.Review}/3la1`;
const review = (text: string, operation: 'create' | 'update' = 'create') => ({
  kind: 'commit' as const, did: ALICE,
  commit: { operation, collection: NSID.Review, rkey: '3la1', cid: CID, record: { $type: NSID.Review, text, createdAt: '2026-11-10T00:00:00.000Z', routeKey: KEY } },
});
const admin = (path: string, body?: unknown, method = 'POST') => exports.default.fetch(`https://indexer.test/admin/${path}`, {
  method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});

describe('moderation', () => {
  it('checks subjects', () => {
    expect(validSubject(ALICE)).toBe(true);
    expect(validSubject(URI)).toBe(true);
    expect(validSubject('did:web:example.com')).toBe(true);
    expect(validSubject('https://www.hikeratlas.com/@alice')).toBe(false);
    expect(validSubject(`at://alice.example.com/${NSID.Review}/3la1`)).toBe(false);
  });

  it('hides a record, and keeps it hidden after an update, until unhidden', async () => {
    await ingest(env.DB, [review('spam')]);
    const r = await admin('hide', { subject: URI, reason: 'feedback#1 spam' });
    expect(await r.json()).toEqual({ subject: URI, hidden: true });
    await ingest(env.DB, [review('still spam', 'update')]);
    expect((await getRouteReviews(env.DB, KEY)).reviews).toEqual([]);
    expect((await getRouteStats(env.DB, [KEY])).routes[0].reviews).toBe(0);
    const list = await (await admin('hidden', undefined, 'GET')).json<{ hidden: { subject: string; reason: string }[] }>();
    expect(list.hidden).toMatchObject([{ subject: URI, reason: 'feedback#1 spam' }]);
    expect(await (await admin('unhide', { subject: URI })).json()).toEqual({ subject: URI, unhidden: true });
    expect((await getRouteReviews(env.DB, KEY)).reviews).toHaveLength(1);
  });

  it('rejects bad requests, and hides itself without the token', async () => {
    expect((await admin('hide', { subject: 'nope', reason: 'x' })).status).toBe(400);
    expect((await admin('hide', { subject: URI })).status).toBe(400);
    const r = await exports.default.fetch('https://indexer.test/admin/hidden');
    expect(r.status).toBe(404);
  });
});
