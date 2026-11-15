import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { NSID } from '../src/lexicons';
import { CURSOR, type Connect, MAX_EVENTS, RECONCILE_REQUESTED, SAFETY_US, type Stream, runJetstream, subscribeUrl } from '../src/jetstream';
import { getState } from '../src/state';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const STRANGER = 'did:plc:ssssssssssssssssssssssss';
const KEY = '1E57E06gbDEBBBICDGF.tn3dBnAuR_Q';
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm';
const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const US = (msAgo: number) => (NOW_MS - msAgo) * 1000;

const fave = (time_us: number, did = ALICE) => JSON.stringify({
  did, time_us, kind: 'commit',
  commit: { rev: 'x', operation: 'create', collection: NSID.Fave, rkey: KEY, cid: CID, record: { $type: NSID.Fave, createdAt: '2026-11-14T11:00:00.000Z' } },
});
const profile = (time_us: number, did = ALICE) => JSON.stringify({
  did, time_us, kind: 'commit',
  commit: { rev: 'x', operation: 'create', collection: NSID.Profile, rkey: 'self', cid: CID, record: { $type: NSID.Profile, createdAt: '2026-11-14T11:00:00.000Z' } },
});
const identity = (time_us: number, did: string, handle: string) => JSON.stringify({ did, time_us, kind: 'identity', identity: { did, handle, seq: 1, time: '' } });

// A Stream playing back messages, then going quiet (or closing).
function fake(messages: string[], { close = false } = {}): { connect: Connect; urls: string[]; closed: () => boolean } {
  const urls: string[] = [];
  let closed = false;
  const connect: Connect = async (url) => {
    urls.push(url);
    const queue = [...messages];
    const s: Stream = {
      async next() { return queue.shift() ?? null; },
      get ended() { return close && !queue.length; },
      close() { closed = true; },
    };
    return s;
  };
  return { connect, urls, closed: () => closed };
}

const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first<{ n: number }>())!.n;

describe('runJetstream', () => {
  it('asks for our collections from the saved cursor', () => {
    expect(subscribeUrl('jetstream2.us-east.bsky.network', 123)).toBe(
      'https://jetstream2.us-east.bsky.network/subscribe?wantedCollections=com.hikeratlas.temp.*&cursor=123');
  });

  it('applies events, saves the cursor, and stops when caught up', async () => {
    await env.DB.prepare('INSERT INTO state (key, value) VALUES (?1, ?2)').bind(CURSOR, String(US(60_000))).run();
    const f = fake([profile(US(50_000)), fave(US(40_000)), fave(US(-1000)), fave(US(-2000))]);
    const r = await runJetstream(env.DB, f.connect, NOW_MS);
    expect(r).toMatchObject({ stopped: 'caught-up', events: 3, stats: { applied: 3 } });
    expect(f.urls[0]).toContain(`cursor=${US(60_000)}`);
    expect(await getState(env.DB, CURSOR)).toBe(String(US(-1000)));
    expect(await count()).toBe(1); // the same fave twice
    expect(f.closed()).toBe(true);
  });

  it('moves a quiet stream\'s cursor up to the run\'s start, less a margin', async () => {
    await env.DB.prepare('INSERT INTO state (key, value) VALUES (?1, ?2)').bind(CURSOR, String(US(600_000))).run();
    const r = await runJetstream(env.DB, fake([fave(US(500_000))]).connect, NOW_MS);
    expect(r.stopped).toBe('quiet');
    expect(await getState(env.DB, CURSOR)).toBe(String(NOW_MS * 1000 - SAFETY_US));
  });

  it('leaves the cursor where it got to when the stream closes', async () => {
    const r = await runJetstream(env.DB, fake([fave(US(500_000))], { close: true }).connect, NOW_MS);
    expect(r.stopped).toBe('closed');
    expect(await getState(env.DB, CURSOR)).toBe(String(US(500_000)));
  });

  it(`stops after ${MAX_EVENTS} events, saving the cursor`, async () => {
    const msgs = Array.from({ length: MAX_EVENTS + 50 }, (_, i) => identity(US(1_000_000 - i * 1000), STRANGER, 'x.example.com'));
    const r = await runJetstream(env.DB, fake(msgs).connect, NOW_MS);
    expect(r).toMatchObject({ stopped: 'cap', events: MAX_EVENTS });
    expect(await getState(env.DB, CURSOR)).toBe(String(US(1_000_000 - (MAX_EVENTS - 1) * 1000)));
  });

  it('drops account and identity events for accounts it doesn\'t know', async () => {
    const r = await runJetstream(env.DB, fake([
      identity(US(9000), STRANGER, 'stranger.example.com'),
      profile(US(8000)),
      identity(US(7000), ALICE, 'alice.example.com'),
    ]).connect, NOW_MS);
    expect(r.stats.applied).toBe(2);
    const actors = (await env.DB.prepare('SELECT did, handle FROM actors').all()).results;
    expect(actors).toEqual([{ did: ALICE, handle: 'alice.example.com' }]);
  });

  it('restarts from now and asks for a reconcile when the cursor is too old', async () => {
    await env.DB.prepare('INSERT INTO state (key, value) VALUES (?1, ?2)').bind(CURSOR, String(US(25 * 3600_000))).run();
    const f = fake([]);
    await runJetstream(env.DB, f.connect, NOW_MS);
    expect(f.urls[0]).toContain(`cursor=${NOW_MS * 1000}`);
    expect(await getState(env.DB, RECONCILE_REQUESTED)).toBe(new Date(NOW_MS).toISOString());
  });

  it('tries the next host when one fails', async () => {
    const f = fake([]);
    let tries = 0;
    const flaky: Connect = async (url) => { if (tries++ === 0) throw new Error('down'); return f.connect(url); };
    const r = await runJetstream(env.DB, flaky, NOW_MS);
    expect(r.host).toBe('jetstream1.us-east.bsky.network');
  });

  it('skips unreadable messages', async () => {
    const r = await runJetstream(env.DB, fake(['not json', '{"kind":"commit"}', fave(US(1000))]).connect, NOW_MS);
    expect(r.stats).toEqual({ applied: 1, skipped: { unreadable: 2 } });
  });
});

describe('KnownAccounts', () => {
  it('reads the known accounts once a run, not once per event', async () => {
    await env.DB.prepare("INSERT INTO actors (did, seen_at) VALUES (?1, '')").bind(ALICE).run();
    const msgs = Array.from({ length: 250 }, (_, i) => identity(US(500_000 - i * 1000), `did:plc:${String(i).padStart(24, 'x')}`, 'x.example.com'));
    msgs.push(identity(US(1000), ALICE, 'alice.example.com'));
    let reads = 0;
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k !== 'prepare') return Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k);
        return (q: string) => { if (/FROM actors/.test(q) && !/^UPDATE/.test(q)) reads++; return t.prepare(q); };
      },
    });
    const r = await runJetstream(db, fake(msgs).connect, NOW_MS);
    expect(r.events).toBe(251);
    expect(reads).toBe(1); // three batches, one load
    expect((await env.DB.prepare('SELECT handle FROM actors').first<{ handle: string }>())!.handle).toBe('alice.example.com');
  });
});
