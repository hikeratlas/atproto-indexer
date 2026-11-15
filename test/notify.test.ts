import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/ingest';
import { NSID } from '../src/lexicons';
import { PER_MINUTE, notify } from '../src/notify';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY = '1E57E06gbDEBBBICDGF.tn3dBnAuR_Q';
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const PDS = 'https://pds.example.com';
const REVIEW = `at://${ALICE}/${NSID.Review}/3lbxyz`;
const record = { $type: NSID.Review, text: 'Lovely', createdAt: '2026-11-15T00:00:00.000Z', routeKey: KEY };

// plc.directory, the handle resolver, and a PDS holding the given records.
function network(records: Record<string, Record<string, unknown>>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(`${u.host}${u.pathname}`);
    const ok = (b: unknown) => new Response(JSON.stringify(b));
    if (u.host === 'plc.directory') return ok({ alsoKnownAs: ['at://alice.example.com'], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    if (u.pathname.endsWith('resolveHandle')) return ok({ did: ALICE });
    if (u.pathname.endsWith('getRecord')) {
      const uri = `at://${u.searchParams.get('repo')}/${u.searchParams.get('collection')}/${u.searchParams.get('rkey')}`;
      const value = records[uri];
      return value ? ok({ uri, cid: CID, value }) : new Response(JSON.stringify({ error: 'RecordNotFound' }), { status: 400 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const rows = async () => (await env.DB.prepare('SELECT uri FROM records').all<{ uri: string }>()).results.map((r) => r.uri);

describe('notify', () => {
  it('indexes a new record now, with a new account\'s PDS and handle', async () => {
    const { f } = network({ [REVIEW]: record });
    expect(await notify(env.DB, f, REVIEW, 1)).toEqual({ status: 200, body: { uri: REVIEW, indexed: true } });
    expect(await rows()).toEqual([REVIEW]);
    expect(await env.DB.prepare('SELECT handle, pds FROM actors').first()).toEqual({ handle: 'alice.example.com', pds: PDS });
  });

  it('removes a record the PDS no longer has', async () => {
    await ingest(env.DB, [{ kind: 'commit', did: ALICE, commit: { operation: 'create', collection: NSID.Review, rkey: '3lbxyz', cid: CID, record } }]);
    await env.DB.prepare('UPDATE actors SET pds = ?1').bind(PDS).run();
    const { f, calls } = network({});
    expect(await notify(env.DB, f, REVIEW, 2)).toEqual({ status: 200, body: { uri: REVIEW, indexed: false } });
    expect(await rows()).toEqual([]);
    expect(calls).toEqual(['pds.example.com/xrpc/com.atproto.repo.getRecord']); // known PDS: no DID lookup
  });

  it('trusts the PDS, not the caller', async () => {
    const { f } = network({ [REVIEW]: { ...record, text: undefined } }); // invalid on the PDS
    const r = await notify(env.DB, f, REVIEW, 3);
    expect(r).toMatchObject({ status: 200, body: { indexed: false, skipped: { invalid: 1 } } });
    expect(await rows()).toEqual([]);
  });

  it('rejects anything but a Hiker Atlas record URI', async () => {
    const { f } = network({});
    for (const uri of [undefined, 'nope', `at://${ALICE}/app.bsky.feed.post/3lbxyz`, `at://alice.example.com/${NSID.Review}/3lbxyz`]) {
      expect((await notify(env.DB, f, uri, 4)).status, String(uri)).toBe(400);
    }
  });

  it('limits notifies per account', async () => {
    const { f } = network({ [REVIEW]: record });
    const did = 'did:plc:rrrrrrrrrrrrrrrrrrrrrrrr';
    const uri = `at://${did}/${NSID.Review}/3lbxyz`;
    for (let i = 0; i < PER_MINUTE; i++) expect((await notify(env.DB, f, uri, 10_000)).status).not.toBe(429);
    expect((await notify(env.DB, f, uri, 10_000)).status).toBe(429);
    expect((await notify(env.DB, f, uri, 80_000)).status).not.toBe(429); // a minute later
  });

  it('answers on /notify with CORS for the site', async () => {
    const pre = await exports.default.fetch('https://indexer.test/notify', { method: 'OPTIONS', headers: { origin: 'https://www.hikeratlas.com' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://www.hikeratlas.com');
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type');
    const bad = await exports.default.fetch('https://indexer.test/notify', { method: 'POST', body: '{"uri":"nope"}', headers: { origin: 'https://www.hikeratlas.com' } });
    expect(bad.status).toBe(400);
  });
});
