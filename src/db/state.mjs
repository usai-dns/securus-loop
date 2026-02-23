// D1 system state operations

export async function getState(db, key) {
  const result = await db.prepare(
    'SELECT value FROM system_state WHERE key = ?'
  ).bind(key).first();
  return result?.value || null;
}

export async function setState(db, key, value) {
  await db.prepare(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value)).run();
}

export async function incrementCounter(db, key) {
  const current = await getState(db, key);
  const next = (parseInt(current || '0', 10) + 1).toString();
  await setState(db, key, next);
  return next;
}
