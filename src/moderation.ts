// The hidden list (#6): records (at:// URIs) and accounts (DIDs) Hiker
// Atlas no longer shows, after a report (hikeratlas/feedback). We can't
// delete anyone's record; every query leaves these out (api.ts), and an
// update to a hidden record stays hidden, as its URI doesn't change.
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+)$/;
const URI = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9.%:-]+)\/[a-zA-Z0-9.-]+\/[A-Za-z0-9._:~-]{1,512}$/;

export function validSubject(s: string): boolean {
  return DID.test(s) || (URI.test(s) && DID.test(URI.exec(s)![1]));
}

export async function hide(db: D1Database, subject: string, reason: string, now = new Date()): Promise<void> {
  await db.prepare('INSERT INTO hidden (subject, reason, at) VALUES (?1, ?2, ?3) ON CONFLICT (subject) DO UPDATE SET reason = ?2, at = ?3')
    .bind(subject, reason, now.toISOString()).run();
}

export async function unhide(db: D1Database, subject: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM hidden WHERE subject = ?1').bind(subject).run();
  return r.meta.changes > 0;
}

export async function listHidden(db: D1Database): Promise<{ subject: string; reason: string; at: string }[]> {
  return (await db.prepare('SELECT subject, reason, at FROM hidden ORDER BY at DESC').all<{ subject: string; reason: string; at: string }>()).results;
}
