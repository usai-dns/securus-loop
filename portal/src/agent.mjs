// Calls securus-agent's /tenant/* endpoints over the AGENT service binding
// (same Cloudflare account; never traverses the public internet) with the
// shared PORTAL_TOKEN. All calls are JSON in / JSON out.
export async function agent(env, path, body = {}) {
  if (!env.AGENT) throw new Error('AGENT service binding missing');
  if (!env.PORTAL_TOKEN) throw new Error('PORTAL_TOKEN not configured');
  const res = await env.AGENT.fetch(new Request('https://securus-agent' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.PORTAL_TOKEN}` }, body: JSON.stringify(body),
  }));
  const j = await res.json().catch(() => ({}));
  if (!res.ok && !j.error) j.error = `agent ${res.status}`;
  return j;
}

// FoxVox-managed credentials for a NEW Securus account. The customer types
// these into Securus's enroll form (plus their ID details + the CAPTCHA);
// FoxVox vaults them so the relay can operate the account afterwards.
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ', alpha = 'abcdefghijkmnpqrstuvwxyz', DIGITS = '23456789';
const pick = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
export function generateSecurusPassword() {
  // Securus rule: ≥8 chars, 1 number, 1 uppercase, 1 lowercase. We do 14, no symbols (some forms reject them).
  let out = pick(ALPHA) + pick(alpha) + pick(DIGITS);
  while (out.length < 14) out += pick(ALPHA + alpha + DIGITS);
  return out.split('').sort(() => (crypto.getRandomValues(new Uint8Array(1))[0] & 1) ? 1 : -1).join('');
}
export function generatePasscode() { return String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000)); }
// Security answers: memorable words, not guessable from the customer's life.
const WORDS = ['copper', 'juniper', 'harbor', 'lantern', 'meadow', 'saffron', 'granite', 'willow', 'cobalt', 'ember', 'orchard', 'summit', 'velvet', 'tundra', 'marble', 'falcon', 'cedar', 'quartz', 'ridge', 'plover'];
export function generateSecurityAnswers() {
  const q = [
    ['What is the name of your first pet?', 'What was your favorite place to visit as a child?', 'In what city were you born?', 'What is the name of your first school?', 'What is your favorite movie?'],
    ['What street did you grow up on?', 'What is your mothers maiden name?', 'What was the make of your first car?', 'What is the name of your first grade teacher?', 'What is your fathers middle name?'],
    ['What is the name of your favorite actor?', 'What is the first name of the person you first kissed?', 'Who was your childhood hero?', 'In what city or town does your nearest sibling live?', 'What is your favorite beverage?'],
  ];
  return q.map((opts) => ({ question: opts[crypto.getRandomValues(new Uint32Array(1))[0] % opts.length], answer: pick(WORDS) + pick(DIGITS) + pick(WORDS) }));
}
