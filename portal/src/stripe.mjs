// Stripe helpers for foxvox-portal (REST via fetch; no SDK). The restricted
// key lives in STRIPE_SECRET_KEY. All money flows through Stripe Checkout +
// the Stripe-hosted customer portal; we never see card data.

export function stripeKey(env) { return (env.STRIPE_SECRET_KEY || '').replace(/\s+/g, ''); }

async function call(env, method, path, params) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${stripeKey(env)}`, ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: params ? new URLSearchParams(flatten(params)) : undefined,
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, ok: resp.status >= 200 && resp.status < 300, body };
}
export const stripeGet = (env, path) => call(env, 'GET', path);
export const stripePost = (env, path, params) => call(env, 'POST', path, params);

// {a:{b:1}} → {'a[b]':1}; arrays → a[0]
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out); else out[key] = String(v);
  }
  return out;
}

export async function getConfig(env, key) {
  return (await env.BILLING.prepare('SELECT value FROM config WHERE key = ?').bind(key).first())?.value || null;
}
export async function setConfig(env, key, value) {
  await env.BILLING.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))").bind(key, value).run();
}

/** Subscription Checkout for the $29/mo plan. Returns {url} or {error}. */
export async function createCheckoutSession(env, { email, signupId, origin, inviteCode }) {
  const priceId = (await getConfig(env, 'stripe_price_id')) || env.STRIPE_PRICE_ID;
  if (!priceId) return { error: 'no price configured — run /stripe/setup-product' };
  const r = await stripePost(env, 'checkout/sessions', {
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/signup?canceled=1`,
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
    client_reference_id: String(signupId),
    metadata: { signup_id: String(signupId), invite_code: inviteCode || '' },
    subscription_data: { metadata: { signup_id: String(signupId) } },
    consent_collection: { terms_of_service: 'required' },
    custom_text: { terms_of_service_acceptance: { message: 'I agree to the [Terms of Service](https://foxvox.ai/terms) and [Privacy Policy](https://foxvox.ai/privacy).' } },
  });
  if (!r.ok) return { error: r.body?.error?.message || `stripe ${r.status}`, raw: r.body?.error };
  return { url: r.body.url, id: r.body.id };
}

export async function retrieveCheckoutSession(env, id) {
  const r = await stripeGet(env, `checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription&expand[]=customer`);
  return r.ok ? r.body : null;
}

export async function createPortalSession(env, customerId, returnUrl) {
  const r = await stripePost(env, 'billing_portal/sessions', { customer: customerId, return_url: returnUrl });
  if (!r.ok) return { error: r.body?.error?.message || `stripe ${r.status}`, code: r.body?.error?.code };
  return { url: r.body.url };
}

// ── Webhook signature (Stripe-Signature: t=…,v1=…) ──
export async function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const t = parts.t; const v1s = header.split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !v1s.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return v1s.some((sig) => timingSafeEqualHex(sig, expected));
}
export async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
