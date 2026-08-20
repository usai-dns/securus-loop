// Signed, expiring session cookie for the payer account page. Payload is
// base64url JSON {p: payer_id, e: expiry_ms}; signature = HMAC-SHA256(SESSION_SECRET).
import { hmacHex } from './stripe.mjs';
const COOKIE = 'fv_session';
const b64u = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

export async function signSession(secret, payerId, { ttlMs = 30 * 24 * 3600 * 1000, now = Date.now() } = {}) {
  const payload = b64u(JSON.stringify({ p: payerId, e: now + ttlMs }));
  return `${payload}.${await hmacHex(secret, payload)}`;
}
export async function verifySession(secret, token, { now = Date.now() } = {}) {
  if (!secret || !token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if ((await hmacHex(secret, payload)) !== sig) return null;
  try { const d = JSON.parse(unb64u(payload)); return d.e > now ? { payerId: d.p } : null; } catch { return null; }
}
export function sessionCookieHeader(token, { maxAgeSec = 30 * 24 * 3600 } = {}) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookieHeader = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
export function readSessionCookie(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
