// foxvox-portal — payments + payer portal for the messaging service.
// Build step 1: health, Stripe key verification, billing schema.
// Build step 5 (partial): public pages on foxvox.ai — /signup (account creation
// with the 10DLC-compliant SMS opt-in), /privacy, /terms, POST /api/signup.
// This worker never touches message content — it binds only foxvox-billing-db.
import { renderSignup, renderSignupDone, renderPrivacy, renderTerms, html, normalizePhone } from './pages.mjs';

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
  `CREATE TABLE IF NOT EXISTS signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT NOT NULL,
    phone TEXT,                            -- E.164 or NULL
    invite_code TEXT,
    service_sms_consent INTEGER NOT NULL DEFAULT 0,   -- 1 = checked Service SMS box (CUSTOMER_CARE + ACCOUNT_NOTIFICATION)
    marketing_sms_consent INTEGER NOT NULL DEFAULT 0, -- 1 = checked Marketing SMS box (MARKETING)
    consent_text_hash TEXT,                -- sha256 of the exact consent strings shown (TCPA proof-of-consent)
    ip TEXT, user_agent TEXT, page_url TEXT,
    payer_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(email)",
  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
];

// secrets pasted through UIs often pick up whitespace — including a NEWLINE in
// the MIDDLE from line-wrapping. Stripe keys are base62 (never contain
// whitespace), so stripping all whitespace is safe and fixes wrapped pastes.
function stripeKey(env) {
  return (env.STRIPE_SECRET_KEY || '').replace(/\s+/g, '');
}

async function stripeGet(env, path) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${stripeKey(env)}` },
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function stripePost(env, path, params) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey(env)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

export default {
  async fetch(request, env) {
   try {
    const url = new URL(request.url);
    const authed = () => env.ADMIN_TOKEN && url.searchParams.get('token') === env.ADMIN_TOKEN;

    // ── Public pages (foxvox.ai via zone routes; also on workers.dev) ──
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/signup')) {
      return html(renderSignup({ code: url.searchParams.get('code') || '' }));
    }
    if (request.method === 'GET' && url.pathname === '/privacy') return html(renderPrivacy());
    if (request.method === 'GET' && url.pathname === '/terms') return html(renderTerms());
    if (request.method === 'GET' && url.pathname === '/signup/done') return html(renderSignupDone({ email: url.searchParams.get('e') || '' }));
    if (request.method === 'POST' && url.pathname === '/api/signup') return handleSignup(request, env, url);

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
      // try several endpoints: a restricted key may 403 on some while being
      // perfectly valid — only a 401 invalid_api_key on all of them means the
      // key itself is bad.
      const probes = {};
      for (const path of ['account', 'products?limit=1', 'customers?limit=1', 'balance']) {
        const r = await stripeGet(env, path);
        probes[path] = {
          status: r.status,
          error: r.status !== 200 ? (r.body?.error?.code || r.body?.error?.type || null) : null,
        };
      }
      const anyOk = Object.values(probes).some(p => p.status === 200);
      const keyMeta = {
        rawLength: env.STRIPE_SECRET_KEY.length,
        trimmedLength: stripeKey(env).length,
        prefix: stripeKey(env).substring(0, 8),
        innerWhitespace: /\s/.test(stripeKey(env)),
      };
      return Response.json({ configured: true, valid: anyOk, probes, keyMeta });
    }

    // idempotent: create the $29/mo subscription product + price. Stores the
    // ids in the config table; re-running returns the stored ids, never dupes.
    if (url.pathname === '/stripe/setup-product') {
      if (!authed()) return Response.json({ error: 'unauthorized' }, { status: 401 });
      try {
      const getCfg = async (k) => (await env.BILLING.prepare("SELECT value FROM config WHERE key = ?").bind(k).first())?.value || null;
      const setCfg = async (k, v) => env.BILLING.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(k, v).run();

      let productId = await getCfg('stripe_product_id');
      let priceId = await getCfg('stripe_price_id');
      if (productId && priceId) {
        return Response.json({ success: true, alreadyExists: true, productId, priceId });
      }

      if (!productId) {
        const p = await stripePost(env, 'products', {
          name: 'Inmate Messaging — Monthly',
          'metadata[slug]': 'inmate-messaging-credits',
          'metadata[included_parts]': '60',
        });
        if (p.status !== 200) return Response.json({ success: false, step: 'product', error: p.body?.error }, { status: 400 });
        productId = p.body.id;
        await setCfg('stripe_product_id', productId);
      }

      if (!priceId) {
        const pr = await stripePost(env, 'prices', {
          product: productId,
          unit_amount: '2900',
          currency: 'usd',
          'recurring[interval]': 'month',
          nickname: '$29/mo per thread — 60 parts included',
        });
        if (pr.status !== 200) return Response.json({ success: false, step: 'price', error: pr.body?.error }, { status: 400 });
        priceId = pr.body.id;
        await setCfg('stripe_price_id', priceId);
      }

      return Response.json({
        success: true, productId, priceId,
        note: "Statement descriptor: FOXVOX-MSGCREDITS (set account-level in the Stripe dashboard; '*' is not allowed in static descriptors).",
      });
      } catch (e) {
        return Response.json({ success: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 3) }, { status: 500 });
      }
    }

    return Response.json({ error: 'not found' }, { status: 404 });
   } catch (e) {
     return Response.json({ fatal: true, error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4) }, { status: 500 });
   }
  },
};

// Proof-of-consent record: who, what they were shown (hashed), when, from where.
// Consent boxes are optional — an account can be created with neither checked.
async function handleSignup(request, env, url) {
  const form = await request.formData().catch(() => null);
  if (!form) return html(renderSignup({ error: 'Please submit the form again.' }), 400);
  const values = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v).trim()]));
  const email = (values.email || '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return html(renderSignup({ error: 'Enter a valid email address.', values }), 400);
  const service = values.serviceConsent === '1' ? 1 : 0;
  const marketing = values.marketingConsent === '1' ? 1 : 0;
  const phone = values.phone ? normalizePhone(values.phone) : null;
  if (values.phone && !phone) return html(renderSignup({ error: 'Enter a valid US mobile number (10 digits).', values }), 400);
  if ((service || marketing) && !phone) return html(renderSignup({ error: 'Enter your mobile number to receive texts, or uncheck the SMS boxes.', values }), 400);
  const { SERVICE_CONSENT, MARKETING_CONSENT } = await import('./consent.mjs');
  const hash = await sha256(SERVICE_CONSENT + '\n' + MARKETING_CONSENT);
  try {
    await env.BILLING.prepare(
      `INSERT INTO signups (name, email, phone, invite_code, service_sms_consent, marketing_sms_consent, consent_text_hash, ip, user_agent, page_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(values.name || null, email, phone, values.code || null, service, marketing, hash,
      request.headers.get('CF-Connecting-IP') || null, (request.headers.get('User-Agent') || '').slice(0, 300), url.origin + '/signup').run();
  } catch (e) {
    // table missing until /migrate runs — fail loudly but politely
    return html(renderSignup({ error: 'We could not save your signup right now. Please try again in a minute.', values }), 500);
  }
  return Response.redirect(url.origin + '/signup/done?e=' + encodeURIComponent(email), 303);
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
