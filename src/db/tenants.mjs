// Tenants — one per connected Securus account (a FoxVox customer). The
// legacy single-tenant data (Dennis) is tenant 'owner', whose credentials come
// from SECURUS_LOGIN_EMAIL/PASS secrets. Customer credentials are stored
// AES-GCM-encrypted (vault.mjs) and decrypted only inside a browser session.
import { decrypt } from '../vault.mjs';
export const OWNER_TENANT = 'owner';

export const TENANT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,                  -- 't_<payer_id>' from the portal
    payer_id INTEGER,
    securus_email TEXT,
    securus_password_enc TEXT,            -- vault ciphertext; NULL for 'owner'
    status TEXT NOT NULL DEFAULT 'unverified',  -- unverified | verified | connected | error | paused
    last_verified_at TEXT,
    last_error TEXT,
    schedule TEXT,                        -- JSON override of schedule.mjs DEFAULT_SCHEDULE
    next_run_at TEXT,                     -- ISO; set by computeNextRun() after each visit
    last_run_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  "INSERT OR IGNORE INTO tenants (id, status) VALUES ('owner', 'connected')",
];
export const TENANT_ALTERS = [
  "ALTER TABLE contacts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'owner'",
  "ALTER TABLE tenants ADD COLUMN schedule TEXT",
  "ALTER TABLE tenants ADD COLUMN next_run_at TEXT",
  "ALTER TABLE tenants ADD COLUMN last_run_at TEXT",
];

export async function ensureTenantSchema(db) {
  const out = [];
  for (const sql of TENANT_SCHEMA) { try { await db.prepare(sql).run(); out.push('ok'); } catch (e) { out.push('error: ' + e.message); } }
  for (const sql of TENANT_ALTERS) { try { await db.prepare(sql).run(); out.push('ok'); } catch (e) { out.push(/duplicate column/i.test(e.message) ? 'ok (exists)' : 'error: ' + e.message); } }
  return out;
}
export async function upsertTenant(db, t) {
  await db.prepare(`INSERT INTO tenants (id, payer_id, securus_email, securus_password_enc, status)
    VALUES (?, ?, ?, ?, COALESCE(?, 'unverified'))
    ON CONFLICT(id) DO UPDATE SET payer_id = COALESCE(excluded.payer_id, tenants.payer_id), securus_email = COALESCE(excluded.securus_email, tenants.securus_email),
      securus_password_enc = COALESCE(excluded.securus_password_enc, tenants.securus_password_enc), status = COALESCE(?, tenants.status), updated_at = datetime('now')`)
    .bind(t.id, t.payer_id ?? null, t.securus_email ?? null, t.securus_password_enc ?? null, t.status ?? null, t.status ?? null).run();
  return getTenant(db, t.id);
}
export const getTenant = (db, id) => db.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first();
export async function setTenantStatus(db, id, status, error = null) {
  await db.prepare("UPDATE tenants SET status = ?, last_error = ?, last_verified_at = CASE WHEN ? IN ('verified','connected') THEN datetime('now') ELSE last_verified_at END, updated_at = datetime('now') WHERE id = ?").bind(status, error, status, id).run();
}
// Credentials for a browser session. 'owner' → worker secrets; others → vault.
export async function tenantCredentials(env, tenant) {
  if (!tenant || tenant.id === OWNER_TENANT) return { email: env.SECURUS_LOGIN_EMAIL, password: env.SECURUS_LOGIN_PASS };
  if (!tenant.securus_password_enc) throw new Error(`tenant ${tenant.id} has no stored credentials`);
  return { email: tenant.securus_email, password: await decrypt(env, tenant.securus_password_enc, tenant.id) };
}
export async function registerTenantContact(db, tenantId, c) {
  await db.prepare(`INSERT INTO contacts (id, securus_id, name, doc_number, language, match_names, persona, active, tenant_id)
    VALUES (?, ?, ?, ?, COALESCE(?, 'en'), ?, COALESCE(?, 'Dennis'), 1, ?)
    ON CONFLICT(id) DO UPDATE SET securus_id = COALESCE(excluded.securus_id, contacts.securus_id), name = excluded.name, doc_number = COALESCE(excluded.doc_number, contacts.doc_number),
      language = excluded.language, match_names = excluded.match_names, active = 1, tenant_id = excluded.tenant_id`)
    .bind(c.id, c.securus_id ?? null, c.name, c.doc_number ?? null, c.language ?? null, c.match_names, c.persona ?? null, tenantId).run();
  return db.prepare('SELECT * FROM contacts WHERE id = ?').bind(c.id).first();
}
export const getTenantContacts = (db, tenantId) => db.prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY id').bind(tenantId).all().then((r) => r.results);
