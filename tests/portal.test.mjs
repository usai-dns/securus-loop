// Portal page tests — guards the 10DLC-compliant opt-in on foxvox.ai/signup.
// The authoritative gate lives in foxvox-a2p (`a2p campaign precheck`, which
// fetches the LIVE page); this file is the fast local tripwire.
import { renderSignup, renderPrivacy, renderTerms, normalizePhone } from '../portal/src/pages.mjs';
import { SERVICE_CONSENT, MARKETING_CONSENT } from '../portal/src/consent.mjs';

let passed = 0, failed = 0; const failures = [];
const assert = (c, n) => { if (c) passed++; else { failed++; failures.push(n); console.log('  FAIL: ' + n); } };
const text = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

console.log('\n--- Portal: signup opt-in compliance ---');
{
  const h = renderSignup(); const t = text(h);
  assert((h.match(/type="checkbox"/g) || []).length === 2, 'exactly two consent checkboxes');
  assert(!/type="checkbox"[^>]*\bchecked\b/.test(h), 'checkboxes unchecked by default');
  assert(!/type="checkbox"[^>]*\brequired\b/.test(h), 'consent not required (not a condition of purchase)');
  assert(t.includes(SERVICE_CONSENT), 'service consent text rendered verbatim');
  assert(t.includes(MARKETING_CONSENT), 'marketing consent text rendered verbatim');
  assert(/id="serviceConsent"/.test(h) && /id="marketingConsent"/.test(h), 'checkbox ids serviceConsent + marketingConsent');
  assert(/href="\/privacy"/.test(h) && /href="\/terms"/.test(h), 'privacy + terms links next to the form');
  assert(/STOP to opt out/i.test(t) && /HELP for help/i.test(t), 'STOP + HELP present');
  assert(/Message and data rates may apply/i.test(t), 'rates disclosure present');
  assert(!/2fa|two-factor|verification code|one-time pass|\botp\b/i.test(t), 'no undeclared-use-case (2FA/OTP) wording');
  assert(!/bit\.ly|tinyurl|t\.co\b/i.test(t), 'no URL shorteners');
  assert(/action="\/api\/signup"/.test(h) && /method="post"/i.test(h), 'form posts to /api/signup');
  assert(text(renderSignup({ error: '<b>x</b>' })).includes('<b>x</b>') === false, 'error text is escaped');
}
console.log('\n--- Portal: privacy + terms ---');
{
  const p = text(renderPrivacy()), tm = text(renderTerms());
  assert(/will not be sold or shared/i.test(p), 'privacy: "will not be sold or shared"');
  assert(/text messaging originator opt-in data and consent/i.test(p), 'privacy: originator opt-in data clause');
  assert(/Service SMS/.test(p) && /Marketing SMS/.test(p), 'privacy: both categories described');
  assert(/replying STOP/i.test(p), 'privacy: STOP');
  assert(/not a condition of purchasing/i.test(tm), 'terms: not a condition of purchase');
  assert(/Carriers are not liable/i.test(tm), 'terms: carrier liability');
  assert(/reply HELP/i.test(tm) && /replying STOP/i.test(tm), 'terms: HELP + STOP');
  assert(!/2fa|two-factor|verification code/i.test(p + tm), 'policies: no 2FA wording');
}
console.log('\n--- Portal: phone normalization ---');
{
  assert(normalizePhone('(720) 555-0100') === '+17205550100', 'normalizes 10-digit');
  assert(normalizePhone('1 720 555 0100') === '+17205550100', 'normalizes 11-digit');
  assert(normalizePhone('555-0100') === null, 'rejects short');
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join('\n')); process.exit(1); }
