// foxvox-portal — payments + payer portal for the messaging service.
// Skeleton (build step 1): health, Stripe key verification, billing schema.
// This worker never touches message content — it binds only foxvox-billing-db.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS payers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sponsorships (
    payer_id INTEGER NOT NULL,
    inmate_contact_id TEXT NOT NULL,      -- contacts.id in the messaging worker
    created_via_code TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(payer_id, inmate_contact_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    generated_by_type TEXT NOT NULL,      -- inmate | payer | admin
    generated_by_id TEXT,
    inmate_contact_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',  -- open | redeemed | expired
    redeemed_by_payer INTEGER,
    generated_at TEXT DEFAULT (datetime('now')),
    redeemed_at TEXT,
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inmate_contact_id TEXT NOT NULL,
    delta INTEGER NOT NULL,               -- credits; balance = SUM(delta)
    reason TEXT NOT NULL,                 -- purchase | usage | refund | adjustment | grant
    ref TEXT,                             -- stripe id / queue part id / note
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_ledger_inmate ON ledger(inmate_contact_id)",
  "CREATE INDEX IF NOT EXISTS idx_codes_inmate ON invite_codes(inmate_contact_id)",
];

async function stripeGet(env, path) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authed = () => env.ADMIN_TOKEN && url.searchParams.get('token') === env.ADMIN_TOKEN;

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'foxvox-portal', ts: new Date().toISOString() });
    }

    // one-time/idempotent schema setup
    if (url.pathname === '/migrate') {
      if (!authed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const results = [];
      for (const sql of SCHEMA) {
        try { await env.BILLING.prepare(sql).run(); results.push('ok'); }
        catch (e) { results.push(`error: ${e.message}`); }
      }
      return Response.json({ success: !results.some(r => r.startsWith('error')), results });
    }

    // verifies the Stripe key WITHOUT exposing it: reports presence + a live
    // API check + masked account info only.
    if (url.pathname === '/stripe/verify') {
      if (!authed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (!env.STRIPE_SECRET_KEY) {
        return Response.json({ configured: false, note: 'STRIPE_SECRET_KEY secret not set on this worker yet' });
      }
      const acct = await stripeGet(env, 'account');
      const ok = acct.status === 200;
      return Response.json({
        configured: true,
        valid: ok,
        httpStatus: acct.status,
        account: ok ? {
          id: (acct.body?.id || '').replace(/^(acct_.{4}).*$/, '$1…'),
          business: acct.body?.business_profile?.name || acct.body?.settings?.dashboard?.display_name || null,
          chargesEnabled: acct.body?.charges_enabled,
        } : (acct.body?.error?.message || 'key rejected'),
      });
    }

    // placeholder landing until build step 3
    if (url.pathname === '/') {
      return new Response('FoxVox — coming soon.', { headers: { 'Content-Type': 'text/plain' } });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
