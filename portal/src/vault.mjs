// AES-GCM credential vault. Key = VAULT_KEY (base64, 32 bytes) shared by
// foxvox-portal (encrypts) and securus-agent (decrypts at run time).
// Ciphertext format: base64url(iv[12] || ciphertext||tag). Plaintext never stored.
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function key(env) {
  if (!env.VAULT_KEY) throw new Error('VAULT_KEY not configured');
  const raw = unb64(env.VAULT_KEY);
  if (raw.length !== 32) throw new Error('VAULT_KEY must be 32 bytes base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encrypt(env, plaintext, aad = '') {
  const k = await key(env); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, k, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
  return b64u(out);
}
export async function decrypt(env, token, aad = '') {
  const k = await key(env); const buf = unb64u(token);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12), additionalData: new TextEncoder().encode(aad) }, k, buf.slice(12));
  return new TextDecoder().decode(pt);
}
