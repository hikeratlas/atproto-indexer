// The state table: small values kept between runs (the Jetstream cursor,
// counters, the reconcile's position).
export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?1').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setState(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db.prepare('INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2').bind(key, value);
}

// Sets an integer only if it's larger than what's there, so two overlapping
// runs can't move a cursor backwards.
export function raiseState(db: D1Database, key: string, value: number): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE
     SET value = CASE WHEN CAST(?2 AS INTEGER) > CAST(value AS INTEGER) THEN ?2 ELSE value END`,
  ).bind(key, String(value));
}
