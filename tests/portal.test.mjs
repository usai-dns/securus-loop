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

// ═══ Website + payment portal (added with build steps 1 + 5) ═══
import { renderHome, renderWelcome, renderAccount, renderNotice } from '../portal/src/pages.mjs';
import { verifyStripeSignature, hmacHex, flatten } from '../portal/src/stripe.mjs';
import { signSession, verifySession, sessionCookieHeader } from '../portal/src/session.mjs';

let p2 = 0, f2 = 0; const fl2 = [];
const ok2 = (c, n) => { if (c) p2++; else { f2++; fl2.push(n); console.log('  FAIL: ' + n); } };

console.log('\n--- Portal: website pages ---');
{
  const h = renderHome(); const t = text(h);
  ok2(/Their message, on your phone/.test(t), 'home hero thesis present');
  ok2(/\$29/.test(t) && /60 (outbound )?messages/.test(t), 'home pricing: $29 + 60 messages');
  ok2(/href="\/signup"/.test(h) && /href="\/account"/.test(h), 'home links to signup + account');
  ok2(/prefers-reduced-motion/.test(h), 'home respects reduced motion');
  ok2(!/2fa|verification code/i.test(t), 'home: no undeclared-use-case wording');
  ok2(text(renderWelcome({ email: 'a@b.co', status: 'complete', subscriptionStatus: 'active' })).includes('Welcome to FoxVox'), 'welcome (paid) copy');
  ok2(text(renderWelcome({ status: 'open' })).includes('Almost there'), 'welcome (unpaid) copy');
  ok2(text(renderAccount({})).includes('My account'), 'account signed-out');
  const a = text(renderAccount({ payer: { email: 'x@y.z' }, subscription: { status: 'active', current_period_end: 1790000000 }, credits: 42 }));
  ok2(a.includes('x@y.z') && a.includes('42') && a.includes('active'), 'account signed-in shows email/credits/status');
  ok2(renderNotice('Nope', '<i>x</i>').includes('&lt;i&gt;x&lt;/i&gt;') && !renderNotice('Nope', '<i>x</i>').includes('<i>x</i>'), 'notice escapes html');
}
console.log('\n--- Portal: stripe signature + session ---');
{
  const secret = 'whsec_test'; const body = '{"id":"evt_1","type":"invoice.paid"}'; const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(secret, `${t}.${body}`);
  ok2(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret), 'valid stripe signature accepted');
  ok2(!(await verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)}`, secret)), 'bad signature rejected');
  ok2(!(await verifyStripeSignature(body, `t=${t - 1000},v1=${await hmacHex(secret, `${t - 1000}.${body}`)}`, secret)), 'stale timestamp rejected');
  ok2(!(await verifyStripeSignature(body, null, secret)), 'missing header rejected');
  const tok = await signSession('s3cret', 7);
  ok2((await verifySession('s3cret', tok))?.payerId === 7, 'session round-trips payer id');
  ok2((await verifySession('other', tok)) === null, 'session rejects wrong secret');
  ok2((await verifySession('s3cret', tok, { now: Date.now() + 31 * 24 * 3600 * 1000 })) === null, 'session expires');
  ok2(/HttpOnly; Secure; SameSite=Lax/.test(sessionCookieHeader(tok)), 'cookie flags');
  ok2(JSON.stringify(flatten({ a: { b: 1 }, c: [ { d: 'x' } ] })) === '{"a[b]":"1","c[0][d]":"x"}', 'flatten nests stripe params');
}
console.log(`\n${p2} passed, ${f2} failed`);
if (f2) { console.log(fl2.join('\n')); process.exit(1); }
