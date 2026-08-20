// foxvox-portal — website + payments + payer portal for the FoxVox messaging service.
// Serves foxvox.ai: / (site), /signup (account + 10DLC-compliant SMS opt-in),
// /welcome, /account, /privacy, /terms; Stripe Checkout + webhooks; admin JSON.
// This worker never touches message content — it binds only foxvox-billing-db.
import { renderHome, renderSignup, renderWelcome, renderAccount, renderNotice, renderPrivacy, renderTerms, html, normalizePhone, PLAN } from './pages.mjs';
import { SERVICE_CONSENT, MARKETING_CONSENT } from './consent.mjs';
import { stripeGet, stripePost, getConfig, setConfig, createCheckoutSession, retrieveCheckoutSession, createPortalSession, verifyStripeSignature } from './stripe.mjs';
import { signSession, verifySession, sessionCookieHeader, clearCookieHeader, readSessionCookie } from './session.mjs';
import { sendMail, mailConfigured, welcomeEmail, loginEmail } from './mail.mjs';

export const SCHEMA = [
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
    stripe_checkout_session_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(email)",
  // Stripe subscription mirror (source of truth is Stripe; webhooks keep this current)
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payer_id INTEGER NOT NULL,
    stripe_subscription_id TEXT UNIQUE NOT NULL,
    stripe_price_id TEXT,
    status TEXT,                           -- active | trialing | past_due | unpaid | canceled | incomplete | paused
    current_period_start INTEGER,          -- unix seconds
    current_period_end INTEGER,
    cancel_at_period_end INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  // Per-payer message-credit ledger (granted per paid invoice; debited per sent part once the
  // relay is wired). balance = SUM(delta). Moves to per-inmate `ledger` at connect time.
  `CREATE TABLE IF NOT EXISTS payer_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payer_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,                  -- grant | usage | refund | adjustment
    ref TEXT UNIQUE,                       -- stripe invoice id etc. (idempotency)
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_payer_ledger ON payer_ledger(payer_id)",
  // Webhook idempotency + audit
  `CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,                   -- evt_…
    type TEXT NOT NULL,
    received_at TEXT DEFAULT (datetime('now')),
    outcome TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
];
// additive migrations for rows created by older schema versions (ignore "duplicate column")
const ALTERS = [
  'ALTER TABLE signups ADD COLUMN stripe_checkout_session_id TEXT',
];

const json = (o, status = 200) => Response.json(o, { status });
const redirect = (url, status = 303) => new Response(null, { status, headers: { Location: url } });

export default {
  async fetch(request, env) {
   try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const authed = () => env.ADMIN_TOKEN && (url.searchParams.get('token') === env.ADMIN_TOKEN || request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`);
    const GET = request.method === 'GET' || request.method === 'HEAD';

    // ── Public site ──
    if (GET && path === '/') return html(renderHome());
    if (GET && path === '/signup') return html(renderSignup({ code: url.searchParams.get('code') || '', error: url.searchParams.get('canceled') ? 'Checkout was canceled — nothing was charged. Submit again when you are ready.' : '' }));
    if (GET && path === '/privacy') return html(renderPrivacy());
    if (GET && path === '/terms') return html(renderTerms());
    if (request.method === 'POST' && path === '/api/signup') return handleSignup(request, env, url);
    if (GET && path === '/welcome') return handleWelcome(request, env, url);
    if (GET && path === '/account') return handleAccount(request, env, url);
    if (request.method === 'POST' && path === '/api/account/portal') return handlePortal(request, env, url);
    if (request.method === 'POST' && path === '/api/account/login') return handleLoginRequest(request, env, url);
    if (GET && path === '/account/login') return handleLoginLink(request, env, url);
    if (GET && path === '/api/account/logout') return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': clearCookieHeader() } });
    if (request.method === 'POST' && path === '/api/stripe/webhook') return handleWebhook(request, env);
    if (GET && path === '/robots.txt') return new Response('User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /welcome\n', { headers: { 'Content-Type': 'text/plain' } });

    if (path === '/health') return json({ ok: true, service: 'foxvox-portal', ts: new Date().toISOString() });

    // ── Admin (token) ──
    if (path === '/migrate') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const results = [];
      for (const sql of SCHEMA) { try { await env.BILLING.prepare(sql).run(); results.push('ok'); } catch (e) { results.push(`error: ${e.message}`); } }
      for (const sql of ALTERS) { try { await env.BILLING.prepare(sql).run(); results.push('ok'); } catch (e) { results.push(/duplicate column/i.test(e.message) ? 'ok (exists)' : `error: ${e.message}`); } }
      return json({ success: !results.some((r) => r.startsWith('error')), results });
    }
    if (path === '/stripe/verify') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      if (!env.STRIPE_SECRET_KEY) return json({ configured: false });
      const probes = {};
      for (const p of ['account', 'products?limit=1', 'customers?limit=1', 'balance', 'webhook_endpoints?limit=1', 'billing_portal/configurations?limit=1']) {
        const r = await stripeGet(env, p); probes[p] = { status: r.status, error: r.status !== 200 ? (r.body?.error?.code || r.body?.error?.type || null) : null };
      }
      return json({ configured: true, valid: Object.values(probes).some((p) => p.status === 200), probes, webhookSecretSet: !!env.STRIPE_WEBHOOK_SECRET, sessionSecretSet: !!env.SESSION_SECRET, mailConfigured: mailConfigured(env) });
    }
    if (path === '/stripe/setup-product') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      let productId = await getConfig(env, 'stripe_product_id'); let priceId = await getConfig(env, 'stripe_price_id');
      if (productId && priceId) return json({ success: true, alreadyExists: true, productId, priceId });
      if (!productId) { const p = await stripePost(env, 'products', { name: 'Inmate Messaging — Monthly', metadata: { slug: 'inmate-messaging-credits', included_parts: String(PLAN.included) } }); if (!p.ok) return json({ success: false, step: 'product', error: p.body?.error }, 400); productId = p.body.id; await setConfig(env, 'stripe_product_id', productId); }
      if (!priceId) { const pr = await stripePost(env, 'prices', { product: productId, unit_amount: String(PLAN.price * 100), currency: 'usd', recurring: { interval: 'month' }, nickname: `$${PLAN.price}/mo per thread — ${PLAN.included} parts included` }); if (!pr.ok) return json({ success: false, step: 'price', error: pr.body?.error }, 400); priceId = pr.body.id; await setConfig(env, 'stripe_price_id', priceId); }
      return json({ success: true, productId, priceId });
    }
    // Registers the Stripe webhook endpoint (needs webhook_endpoints write on the key). Returns the
    // signing secret ONCE — put it in the STRIPE_WEBHOOK_SECRET worker secret.
    if (path === '/stripe/setup-webhook' && request.method === 'POST') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const existing = await getConfig(env, 'stripe_webhook_endpoint_id');
      if (existing && !url.searchParams.get('force')) return json({ success: true, alreadyExists: true, endpointId: existing, note: 'secret was shown once at creation; rotate in Stripe dashboard if lost' });
      const r = await stripePost(env, 'webhook_endpoints', { url: 'https://foxvox.ai/api/stripe/webhook', enabled_events: WEBHOOK_EVENTS, description: 'foxvox-portal', api_version: '2024-06-20' });
      if (!r.ok) return json({ success: false, error: r.body?.error, hint: 'create it in the Stripe dashboard → Developers → Webhooks → https://foxvox.ai/api/stripe/webhook with the listed events, then `wrangler secret put STRIPE_WEBHOOK_SECRET`', events: WEBHOOK_EVENTS }, 400);
      await setConfig(env, 'stripe_webhook_endpoint_id', r.body.id);
      return json({ success: true, endpointId: r.body.id, signingSecret_SHOWN_ONCE: r.body.secret, next: 'printf "<secret>" | npx wrangler secret put STRIPE_WEBHOOK_SECRET' });
    }
    if (path === '/admin/test-mail' && request.method === 'POST') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const to = url.searchParams.get('to'); if (!to) return json({ error: 'to required' }, 400);
      try { return json(await sendMail(env, { to, subject: 'FoxVox mailer test', text: 'If you can read this, foxvox-portal can send email as foxone@foxvox.ai.' })); }
      catch (e) { return json({ ok: false, error: e.message }, 502); }
    }
    if (path === '/admin/signups') { if (!authed()) return json({ error: 'unauthorized' }, 401); return json((await env.BILLING.prepare('SELECT id,name,email,phone,invite_code,service_sms_consent,marketing_sms_consent,payer_id,stripe_checkout_session_id,created_at FROM signups ORDER BY id DESC LIMIT 200').all()).results); }
    if (path === '/admin/payers') { if (!authed()) return json({ error: 'unauthorized' }, 401); return json((await env.BILLING.prepare(`SELECT p.id,p.email,p.stripe_customer_id,p.created_at,s.status,s.current_period_end,s.cancel_at_period_end,(SELECT COALESCE(SUM(delta),0) FROM payer_ledger l WHERE l.payer_id=p.id) credits FROM payers p LEFT JOIN subscriptions s ON s.payer_id=p.id ORDER BY p.id DESC LIMIT 200`).all()).results); }
    if (path === '/admin/events') { if (!authed()) return json({ error: 'unauthorized' }, 401); return json((await env.BILLING.prepare('SELECT * FROM stripe_events ORDER BY received_at DESC LIMIT 100').all()).results); }

    return html(renderNotice('Page not found', 'That page does not exist. Try the home page or your account.', { cta: 'Go home', href: '/' }), 404);
   } catch (e) {
     return json({ fatal: true, error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4) }, 500);
   }
  },
};

const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'charge.refunded', 'charge.dispute.created'];

// ── Signup → proof-of-consent row → Stripe Checkout ──
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
  const hash = await sha256(SERVICE_CONSENT + '\n' + MARKETING_CONSENT);
  let signupId;
  try {
    const r = await env.BILLING.prepare(
      `INSERT INTO signups (name, email, phone, invite_code, service_sms_consent, marketing_sms_consent, consent_text_hash, ip, user_agent, page_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(values.name || null, email, phone, values.code || null, service, marketing, hash,
      request.headers.get('CF-Connecting-IP') || null, (request.headers.get('User-Agent') || '').slice(0, 300), url.origin + '/signup').first();
    signupId = r?.id;
  } catch (e) {
    return html(renderSignup({ error: 'We could not save your details right now. Please try again in a minute.', values }), 500);
  }
  const origin = publicOrigin(url);
  const co = await createCheckoutSession(env, { email, signupId, origin, inviteCode: values.code || '' });
  if (co.error) return html(renderSignup({ error: `Checkout is unavailable right now (${co.error}). Your details were saved — email ${'foxone@foxvox.ai'} and we will finish setup with you.`, values }), 502);
  await env.BILLING.prepare('UPDATE signups SET stripe_checkout_session_id = ? WHERE id = ?').bind(co.id, signupId).run().catch(() => {});
  return redirect(co.url);
}

// ── After Checkout: confirm with Stripe, upsert payer, set session cookie ──
async function handleWelcome(request, env, url) {
  const sid = url.searchParams.get('session_id');
  if (!sid) return html(renderNotice('Missing checkout session', 'Return to the page Stripe sent you to after payment, or sign in to your account.', { cta: 'My account', href: '/account' }), 400);
  const s = await retrieveCheckoutSession(env, sid);
  if (!s) return html(renderNotice('Could not confirm payment', 'We could not load that checkout session. If you were charged, email foxone@foxvox.ai and we will sort it out.', { cta: 'My account', href: '/account' }), 502);
  const email = (s.customer_details?.email || s.customer_email || '').toLowerCase();
  const customerId = typeof s.customer === 'string' ? s.customer : s.customer?.id;
  const sub = typeof s.subscription === 'object' ? s.subscription : null;
  const headers = {};
  if (s.status === 'complete' && email) {
    const payer = await upsertPayer(env, email, customerId);
    if (s.client_reference_id) await env.BILLING.prepare('UPDATE signups SET payer_id = ? WHERE id = ? AND payer_id IS NULL').bind(payer.id, Number(s.client_reference_id)).run().catch(() => {});
    if (sub) await upsertSubscription(env, payer.id, sub);
    if (env.SESSION_SECRET) headers['Set-Cookie'] = sessionCookieHeader(await signSession(env.SESSION_SECRET, payer.id));
    await maybeSendWelcome(env, payer, publicOrigin(url));
  }
  return html(renderWelcome({ email, status: s.status, subscriptionStatus: sub?.status || (s.payment_status === 'paid' ? 'active' : s.payment_status) }), 200, headers);
}

async function currentPayer(request, env) {
  const tok = readSessionCookie(request);
  const sess = await verifySession(env.SESSION_SECRET, tok);
  if (!sess) return null;
  return env.BILLING.prepare('SELECT * FROM payers WHERE id = ?').bind(sess.payerId).first();
}

async function handleAccount(request, env, url) {
  const payer = await currentPayer(request, env);
  const stripePortalLoginUrl = await getConfig(env, 'stripe_portal_login_url');
  if (!payer) return html(renderAccount({ stripePortalLoginUrl, error: url.searchParams.get('err') || '', notice: url.searchParams.get('sent') ? 'If that email has a FoxVox account, a sign-in link is on its way. It expires in 20 minutes.' : '', canEmail: mailConfigured(env) }));
  const subscription = await env.BILLING.prepare('SELECT * FROM subscriptions WHERE payer_id = ? ORDER BY updated_at DESC LIMIT 1').bind(payer.id).first();
  const credits = (await env.BILLING.prepare('SELECT COALESCE(SUM(delta),0) c FROM payer_ledger WHERE payer_id = ?').bind(payer.id).first())?.c || 0;
  const signup = await env.BILLING.prepare('SELECT service_sms_consent, marketing_sms_consent, phone FROM signups WHERE payer_id = ? OR email = ? ORDER BY id DESC LIMIT 1').bind(payer.id, payer.email).first();
  return html(renderAccount({ payer, subscription, credits, signup, portalError: url.searchParams.get('perr') || '' }));
}

async function handlePortal(request, env, url) {
  const payer = await currentPayer(request, env);
  if (!payer) return redirect('/account?err=' + encodeURIComponent('Please sign in first.'));
  if (!payer.stripe_customer_id) return redirect('/account?perr=' + encodeURIComponent('No billing profile yet — complete checkout first.'));
  const r = await createPortalSession(env, payer.stripe_customer_id, publicOrigin(url) + '/account');
  if (r.error) {
    const login = await getConfig(env, 'stripe_portal_login_url');
    if (login) return redirect(login);
    return redirect('/account?perr=' + encodeURIComponent('Billing portal is unavailable right now — email foxone@foxvox.ai to make changes.'));
  }
  return redirect(r.url);
}

// ── Stripe webhook: verify signature, dedupe, mirror state, grant credits ──
async function handleWebhook(request, env) {
  const raw = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'webhook secret not configured' }, 503);
  const ok = await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'bad signature' }, 400);
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const ins = await env.BILLING.prepare('INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)').bind(evt.id, evt.type).run();
  if (!ins.meta?.changes) return json({ received: true, duplicate: true });
  let outcome = 'ignored';
  try { outcome = await applyStripeEvent(env, evt); }
  catch (e) { outcome = 'error: ' + e.message; }
  await env.BILLING.prepare('UPDATE stripe_events SET outcome = ? WHERE id = ?').bind(outcome, evt.id).run();
  return json({ received: true, outcome });
}

export async function applyStripeEvent(env, evt) {
  const o = evt.data?.object || {};
  switch (evt.type) {
    case 'checkout.session.completed': {
      const email = (o.customer_details?.email || o.customer_email || '').toLowerCase();
      if (!email) return 'no email';
      const payer = await upsertPayer(env, email, typeof o.customer === 'string' ? o.customer : o.customer?.id);
      if (o.client_reference_id) await env.BILLING.prepare('UPDATE signups SET payer_id = ? WHERE id = ? AND payer_id IS NULL').bind(payer.id, Number(o.client_reference_id)).run();
      if (typeof o.subscription === 'string') { const r = await stripeGet(env, `subscriptions/${o.subscription}`); if (r.ok) await upsertSubscription(env, payer.id, r.body); }
      await maybeSendWelcome(env, payer, 'https://foxvox.ai');
      return `payer ${payer.id}`;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const payer = await payerByCustomer(env, o.customer);
      if (!payer) return 'unknown customer';
      await upsertSubscription(env, payer.id, o);
      return `sub ${o.id} ${o.status}`;
    }
    case 'invoice.paid': {
      const payer = await payerByCustomer(env, o.customer);
      if (!payer) return 'unknown customer';
      if (o.amount_paid > 0 || o.billing_reason === 'subscription_create') {
        const r = await env.BILLING.prepare('INSERT OR IGNORE INTO payer_ledger (payer_id, delta, reason, ref) VALUES (?, ?, ?, ?)').bind(payer.id, PLAN.included, 'grant', o.id).run();
        return r.meta?.changes ? `granted ${PLAN.included} to payer ${payer.id}` : 'already granted';
      }
      return 'zero invoice';
    }
    case 'invoice.payment_failed': {
      const payer = await payerByCustomer(env, o.customer);
      if (payer && o.subscription) await env.BILLING.prepare("UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now') WHERE stripe_subscription_id = ?").bind(o.subscription).run();
      return payer ? `past_due payer ${payer.id}` : 'unknown customer';
    }
    case 'charge.refunded': {
      const payer = await payerByCustomer(env, o.customer);
      if (!payer) return 'unknown customer';
      // full refund → claw back this cycle's grant (never below zero is enforced at usage time)
      if (o.refunded && o.amount_refunded >= o.amount) {
        await env.BILLING.prepare('INSERT OR IGNORE INTO payer_ledger (payer_id, delta, reason, ref) VALUES (?, ?, ?, ?)').bind(payer.id, -PLAN.included, 'refund', 'refund:' + o.id).run();
        return `refund payer ${payer.id}`;
      }
      return 'partial refund noted';
    }
    case 'charge.dispute.created': {
      const payer = await payerByCustomer(env, o.customer);
      if (payer) await env.BILLING.prepare("UPDATE subscriptions SET status = 'paused', updated_at = datetime('now') WHERE payer_id = ?").bind(payer.id).run();
      return payer ? `dispute → paused payer ${payer.id}` : 'unknown customer';
    }
    default: return 'ignored';
  }
}

async function upsertPayer(env, email, customerId) {
  await env.BILLING.prepare('INSERT INTO payers (email, stripe_customer_id) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET stripe_customer_id = COALESCE(excluded.stripe_customer_id, payers.stripe_customer_id)').bind(email, customerId || null).run();
  return env.BILLING.prepare('SELECT * FROM payers WHERE email = ?').bind(email).first();
}
async function payerByCustomer(env, customerId) {
  if (!customerId) return null;
  const p = await env.BILLING.prepare('SELECT * FROM payers WHERE stripe_customer_id = ?').bind(customerId).first();
  if (p) return p;
  const r = await stripeGet(env, `customers/${customerId}`);
  if (r.ok && r.body.email) return upsertPayer(env, r.body.email.toLowerCase(), customerId);
  return null;
}
async function upsertSubscription(env, payerId, sub) {
  const price = sub.items?.data?.[0]?.price?.id || null;
  await env.BILLING.prepare(`INSERT INTO subscriptions (payer_id, stripe_subscription_id, stripe_price_id, status, current_period_start, current_period_end, cancel_at_period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET status = excluded.status, stripe_price_id = excluded.stripe_price_id, current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = datetime('now')`)
    .bind(payerId, sub.id, price, sub.status || null, sub.current_period_start || null, sub.current_period_end || null, sub.cancel_at_period_end ? 1 : 0).run();
}

function publicOrigin(url) { return url.hostname.endsWith('workers.dev') ? url.origin : 'https://foxvox.ai'; }
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Welcome email (once per payer) ──
async function maybeSendWelcome(env, payer, origin) {
  if (!mailConfigured(env)) return;
  const key = 'welcome_sent:' + payer.id;
  const done = await env.BILLING.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
  if (done) return;
  try {
    await sendMail(env, welcomeEmail({ email: payer.email, accountUrl: origin + '/account' }));
    await env.BILLING.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(key, new Date().toISOString()).run();
  } catch (e) { console.error('welcome mail failed', payer.email, e.message); }
}

// ── Email sign-in link: POST email → signed 20-min token → /account/login?t= ──
async function handleLoginRequest(request, env, url) {
  const form = await request.formData().catch(() => null);
  const email = String(form?.get('email') || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirect('/account?err=' + encodeURIComponent('Enter a valid email address.'));
  const payer = await env.BILLING.prepare('SELECT * FROM payers WHERE email = ?').bind(email).first();
  // Always respond the same way (no account enumeration).
  if (payer && env.SESSION_SECRET && mailConfigured(env)) {
    const t = await signSession(env.SESSION_SECRET, payer.id, { ttlMs: 20 * 60 * 1000 });
    try { await sendMail(env, loginEmail({ email, loginUrl: publicOrigin(url) + '/account/login?t=' + encodeURIComponent(t) })); }
    catch (e) { console.error('login mail failed', email, e.message); }
  }
  return redirect('/account?sent=1');
}
async function handleLoginLink(request, env, url) {
  const sess = await verifySession(env.SESSION_SECRET, url.searchParams.get('t') || '');
  if (!sess) return html(renderNotice('Link expired', 'That sign-in link is no longer valid. Request a new one from My account.', { cta: 'My account', href: '/account' }), 400);
  return new Response(null, { status: 303, headers: { Location: '/account', 'Set-Cookie': sessionCookieHeader(await signSession(env.SESSION_SECRET, sess.payerId)) } });
}
