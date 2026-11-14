// Follows Jetstream (#3). Run by the cron every minute: connect from the
// saved cursor, apply events through ingest, save the cursor after each
// batch, and stop once caught up, quiet, or at the run's cap.
//
// The cap is about CPU: the Workers Free plan gives a cron run 10 ms, and a
// Worker can't measure its own CPU (its clock stands still while code runs),
// so a run stops after MAX_EVENTS events. Live traffic for our collections
// is ~35 events a minute (nearly all account and identity events, which
// Jetstream sends whatever the filter), so a run that's behind catches up
// MAX_EVENTS a minute. A run killed anyway loses at most one batch.
import { type IndexEvent, type IngestStats, ingest } from './ingest';
import { getState, raiseState, setState } from './state';

export const HOSTS = [
  'jetstream2.us-east.bsky.network',
  'jetstream1.us-east.bsky.network',
  'jetstream1.us-west.bsky.network',
  'jetstream2.us-west.bsky.network',
];
export const COLLECTIONS = 'com.hikeratlas.temp.*';

export const MAX_EVENTS = 300;
export const BATCH = 100;
export const IDLE_MS = 3000; // quiet this long: caught up
export const MAX_RUN_MS = 45000; // never into the next minute's run
// When quiet, the cursor moves to the run's start less this, so an event
// still on its way is replayed next time rather than skipped (upserts make
// replays harmless).
export const SAFETY_US = 30_000_000;
// Older than this (Jetstream keeps about a day), replay can't be trusted:
// the cursor restarts from now and a reconcile is requested (#4).
export const MAX_CURSOR_AGE_US = 20 * 3600 * 1_000_000;

export const CURSOR = 'jetstream.cursor';
export const RECONCILE_REQUESTED = 'reconcile.requested';

// A source of Jetstream messages: the next message's text, or null when
// none arrived within the timeout or the stream ended (then ended is true).
export interface Stream {
  next(timeoutMs: number): Promise<string | null>;
  readonly ended: boolean;
  close(): void;
}
export type Connect = (url: string) => Promise<Stream>;

export interface RunResult {
  host: string | null;
  events: number;
  stats: IngestStats;
  cursor: number | null;
  stopped: 'caught-up' | 'quiet' | 'cap' | 'time' | 'closed' | 'no-connection';
  // Why the hosts tried before (or instead of) the one used failed.
  errors?: string[];
}

export function subscribeUrl(host: string, cursor: number | null): string {
  const u = new URL(`https://${host}/subscribe`);
  u.searchParams.set('wantedCollections', COLLECTIONS);
  if (cursor !== null) u.searchParams.set('cursor', String(cursor));
  return u.toString();
}

// Account and identity events come for every account on the network; only
// those for accounts we know (or that appear in the same batch) are kept,
// without touching D1 for the rest.
async function relevant(db: D1Database, events: IndexEvent[]): Promise<IndexEvent[]> {
  const asked = [...new Set(events.filter((e) => e.kind !== 'commit').map((e) => e.did))];
  if (!asked.length) return events;
  const { results } = await db.prepare('SELECT did FROM actors WHERE did IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(asked)).all<{ did: string }>();
  const known = new Set(results.map((r) => r.did));
  const out: IndexEvent[] = [];
  for (const e of events) {
    if (e.kind === 'commit') known.add(e.did);
    else if (!known.has(e.did)) continue;
    out.push(e);
  }
  return out;
}

function parse(text: string): IndexEvent | null {
  try {
    const e = JSON.parse(text) as IndexEvent;
    if (typeof e?.did !== 'string' || typeof e.time_us !== 'number') return null;
    if (e.kind === 'commit' ? !e.commit : e.kind === 'account' ? !e.account : e.kind === 'identity' ? !e.identity : true) return null;
    return e;
  } catch {
    return null;
  }
}

export async function runJetstream(db: D1Database, connect: Connect, nowMs = Date.now()): Promise<RunResult> {
  const startUs = nowMs * 1000;
  const saved = await getState(db, CURSOR);
  let cursor: number | null = saved === null ? null : Number(saved);
  if (cursor !== null && startUs - cursor > MAX_CURSOR_AGE_US) {
    // Too far behind to replay: start from now, and let a reconcile fill the gap.
    cursor = startUs;
    await db.batch([setState(db, CURSOR, String(cursor)), setState(db, RECONCILE_REQUESTED, new Date(nowMs).toISOString())]);
  }

  const result: RunResult = { host: null, events: 0, stats: { applied: 0, skipped: {} }, cursor, stopped: 'no-connection' };
  let stream: Stream | null = null;
  for (const host of HOSTS) {
    try {
      stream = await connect(subscribeUrl(host, cursor));
      result.host = host;
      break;
    } catch (err) {
      (result.errors ??= []).push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!stream) return result;

  let batch: IndexEvent[] = [];
  let last: number | null = null; // the last event's time_us
  const flush = async () => {
    if (!batch.length && last === null) return;
    const s = await ingest(db, await relevant(db, batch));
    result.stats.applied += s.applied;
    for (const [k, v] of Object.entries(s.skipped)) result.stats.skipped[k] = (result.stats.skipped[k] ?? 0) + v;
    batch = [];
    if (last !== null) {
      await raiseState(db, CURSOR, last).run();
      result.cursor = Math.max(result.cursor ?? 0, last);
    }
  };

  const deadline = Date.now() + MAX_RUN_MS;
  try {
    for (;;) {
      if (result.events >= MAX_EVENTS) { result.stopped = 'cap'; break; }
      if (Date.now() >= deadline) { result.stopped = 'time'; break; }
      const text = await stream.next(IDLE_MS);
      if (text === null) {
        result.stopped = stream.ended ? 'closed' : 'quiet';
        break;
      }
      result.events++;
      const e = parse(text);
      if (!e) { result.stats.skipped['unreadable'] = (result.stats.skipped['unreadable'] ?? 0) + 1; continue; }
      batch.push(e);
      last = e.time_us!;
      if (last >= startUs) { result.stopped = 'caught-up'; break; }
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    if (result.stopped === 'quiet') {
      // Nothing more up to about now: move the cursor up to the run's start
      // (less a margin), so a quiet stream doesn't age the cursor.
      const quietTo = startUs - SAFETY_US;
      if ((result.cursor ?? 0) < quietTo) {
        await raiseState(db, CURSOR, quietTo).run();
        result.cursor = quietTo;
      }
    }
  } finally {
    stream.close();
  }
  return result;
}

// Records how the run went, for /health.
export async function recordRun(db: D1Database, r: RunResult, nowMs = Date.now()): Promise<void> {
  await db.batch([
    setState(db, 'jetstream.lastRun', JSON.stringify({ at: new Date(nowMs).toISOString(), ...r })),
  ]);
}

// A Stream over an outbound WebSocket (workerd: fetch with Upgrade).
export const connectWebSocket: Connect = async (url) => {
  const resp = await fetch(url, { headers: { Upgrade: 'websocket' } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`${new URL(url).host}: no WebSocket (HTTP ${resp.status})`);
  ws.accept();
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  ws.addEventListener('message', (m) => {
    queue.push(typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data as ArrayBuffer));
    wake?.();
  });
  const end = () => { ended = true; wake?.(); };
  ws.addEventListener('close', end);
  ws.addEventListener('error', end);
  return {
    async next(timeoutMs) {
      if (!queue.length && !ended) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { wake = null; resolve(); }, timeoutMs);
          wake = () => { clearTimeout(t); wake = null; resolve(); };
        });
      }
      return queue.shift() ?? null;
    },
    get ended() { return ended && !queue.length; },
    close() {
      try { ws.close(1000, 'done'); } catch { /* already closed */ }
    },
  };
};
