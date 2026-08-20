// Public pages served by foxvox-portal on foxvox.ai: /signup (account creation
// with the 10DLC-compliant SMS opt-in), /privacy, /terms. Plain HTML, no
// framework, dark FoxVox palette. Consent copy comes from consent.mjs.
import { SERVICE_CONSENT, MARKETING_CONSENT, LEGAL } from './consent.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const monthYear = () => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/Denver' });
const year = () => new Date().getFullYear();

const CSS = `
:root{--fox:#FF6B1A;--amber:#FFB347;--deep:#E84D0E;--bg:#0A0A0A;--bg2:#111;--surf:#1A1A1A;--tx:#fff;--tx2:#A0A0A0;--mute:#666;--line:rgba(255,107,26,.18)}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:"Plus Jakarta Sans",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--tx);line-height:1.6;min-height:100vh}
a{color:var(--amber)}
header{padding:1.1rem 1.5rem;border-bottom:1px solid var(--line);background:var(--bg2)}
.nav{max-width:960px;margin:0 auto;display:flex;justify-content:space-between;align-items:center}
.logo{display:flex;align-items:center;gap:.6rem;color:#fff;text-decoration:none;font-weight:800;letter-spacing:.04em;font-size:1.15rem}
.logo i{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,var(--fox),var(--amber));display:inline-block;box-shadow:0 0 18px rgba(255,107,26,.35)}
.nav a.l{color:var(--tx2);text-decoration:none;font-size:.9rem;margin-left:1.2rem}
main{max-width:960px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
.hero h1{font-size:clamp(1.8rem,4vw,2.6rem);line-height:1.15;font-weight:800}
.hero h1 span{color:var(--fox)}
.hero p{color:var(--tx2);margin:.8rem 0 0;max-width:640px}
.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:2.5rem;margin-top:2.2rem;align-items:start}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
.card{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:1.5rem}
.card h2{font-size:1.1rem;margin-bottom:.9rem}
label.f{display:block;font-size:.85rem;color:var(--tx2);margin:.9rem 0 .3rem}
input[type=text],input[type=email],input[type=tel]{width:100%;background:#0d0d0d;border:1px solid #2a2a2a;color:#fff;border-radius:9px;padding:.7rem .8rem;font-size:1rem}
input:focus{outline:2px solid var(--fox);outline-offset:1px;border-color:var(--fox)}
.consent{display:flex;gap:.65rem;align-items:flex-start;font-size:.8rem;color:var(--tx2);margin-top:.9rem;line-height:1.5}
.consent input{margin-top:3px;flex-shrink:0;width:16px;height:16px;accent-color:var(--fox)}
.links{font-size:.8rem;margin-top:.8rem;color:var(--mute)}.links a{margin-right:1rem}
button{margin-top:1.1rem;width:100%;background:linear-gradient(135deg,var(--fox),var(--deep));color:#fff;border:0;border-radius:10px;padding:.85rem 1.2rem;font-size:1rem;font-weight:700;cursor:pointer}
button:hover{filter:brightness(1.08)}
.fine{font-size:.78rem;color:var(--mute);margin-top:.9rem}
.how li{margin:.6rem 0;color:var(--tx2)}.how b{color:#fff}
.price{font-family:"JetBrains Mono",ui-monospace,monospace;color:var(--amber);font-size:1.35rem;margin:.4rem 0 .2rem}
.doc h1{font-size:2rem;margin-bottom:.25rem}.doc .updated{color:var(--mute);font-size:.9rem;margin-bottom:1.6rem}
.doc h2{font-size:1.15rem;color:var(--amber);margin:1.8rem 0 .5rem}.doc p,.doc li{color:#cfcfcf}.doc p{margin-bottom:.9rem}.doc ul{margin:.5rem 0 .9rem 1.3rem}.doc li{margin-bottom:.4rem}
.ok{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:2rem;text-align:center;max-width:560px;margin:2rem auto}
footer{border-top:1px solid var(--line);padding:1.5rem;text-align:center;color:var(--mute);font-size:.8rem}
footer a{color:var(--tx2);text-decoration:none;margin:0 .5rem}`;

function shell(title, body, { description = 'FoxVox keeps you connected with your incarcerated loved one — messages relayed to your phone, replies sent back, automatically.' } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | ${esc(LEGAL.brand)}</title><meta name="description" content="${esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header><div class="nav"><a class="logo" href="/"><i></i>${esc(LEGAL.brand)}</a><nav><a class="l" href="${LEGAL.signupPath}">Sign up</a><a class="l" href="${LEGAL.privacyPath}">Privacy</a><a class="l" href="${LEGAL.termsPath}">Terms</a></nav></div></header>
<main>${body}</main>
<footer>&copy; ${year()} ${esc(LEGAL.legalName)}. All rights reserved. <a href="${LEGAL.privacyPath}">Privacy Policy</a> <a href="${LEGAL.termsPath}">Terms of Service</a> <a href="mailto:${LEGAL.supportEmail}">${LEGAL.supportEmail}</a></footer>
</body></html>`;
}

export function renderSignup({ error = '', values = {}, code = '' } = {}) {
  const v = (k) => esc(values[k] || '');
  const body = `
<section class="hero"><h1>Stay connected. <span>Every message, on your phone.</span></h1>
<p>FoxVox relays messages between you and your incarcerated loved one through the facility's approved messaging platform — new messages reach your phone, and your replies go straight back. $29/month per contact, 60 messages included.</p></section>
<div class="grid">
<form class="card" method="post" action="/api/signup" novalidate>
  <h2>Create your account</h2>
  ${error ? `<p style="color:#ff8a65;font-size:.9rem">${esc(error)}</p>` : ''}
  <label class="f" for="name">Full name</label><input type="text" id="name" name="name" autocomplete="name" value="${v('name')}">
  <label class="f" for="email">Email</label><input type="email" id="email" name="email" autocomplete="email" value="${v('email')}">
  <label class="f" for="phone">Mobile number</label><input type="tel" id="phone" name="phone" autocomplete="tel" placeholder="(720) 555-0100" value="${v('phone')}">
  <label class="f" for="code">Invite code <span style="color:var(--mute)">(optional)</span></label><input type="text" id="code" name="code" autocomplete="off" value="${esc(code || values.code || '')}">
  <label class="consent"><input type="checkbox" id="serviceConsent" name="serviceConsent" value="1"><span>${esc(SERVICE_CONSENT)}</span></label>
  <label class="consent"><input type="checkbox" id="marketingConsent" name="marketingConsent" value="1"><span>${esc(MARKETING_CONSENT)}</span></label>
  <div class="links"><a href="${LEGAL.privacyPath}">Privacy Policy</a><a href="${LEGAL.termsPath}">Terms of Service</a></div>
  <button type="submit">Create account</button>
  <p class="fine">Consent to receive text messages is not a condition of purchase. Message and data rates may apply. Reply STOP to opt out, HELP for help.</p>
</form>
<aside class="card"><h2>How it works</h2>
<ol class="how">
<li><b>Connect</b> — link or create the messaging account for your contact's facility. Your credentials are encrypted; FoxVox never reads more than it needs to relay.</li>
<li><b>Relay</b> — when your contact writes, FoxVox texts you (if you opt in to service SMS). Reply to the text and FoxVox sends it back through the platform.</li>
<li><b>Fund</b> — one plan, no surprises.</li></ol>
<div class="price">$29 / month</div><p style="color:var(--tx2);font-size:.9rem">per contact · 60 outbound messages included · $0.50 per extra message · cancel anytime</p>
</aside></div>`;
  return shell('Sign up', body);
}

export function renderSignupDone({ email } = {}) {
  return shell('You\'re in', `<div class="ok"><h1 style="font-size:1.6rem;margin-bottom:.5rem">Thanks — you're on the list.</h1><p style="color:var(--tx2)">We saved your details${email ? ` for <b style="color:#fff">${esc(email)}</b>` : ''}. We'll reach out by email with your next step: connecting your contact and funding your plan.</p><p class="fine">If you opted in to texts, you can reply STOP at any time to opt out.</p></div>`);
}

export function renderPrivacy() {
  const B = esc(LEGAL.brand), L = esc(LEGAL.legalName), E = esc(LEGAL.supportEmail);
  const body = `<article class="doc"><h1>Privacy Policy</h1><p class="updated">Last updated: ${monthYear()}</p>
<p>${L} ("${B}," "we," "us," or "our") respects your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you visit foxvox.ai or use the ${B} service.</p>
<h2>1. Information We Collect</h2><ul>
<li><strong>Personal data:</strong> name, email address, mobile phone number, and billing details you provide when creating an account or purchasing.</li>
<li><strong>Service data:</strong> information needed to provide the service, including the messages you send and receive through ${B} and the credentials you authorize us to use for the facility messaging platform (stored encrypted).</li>
<li><strong>Usage data:</strong> IP address, browser type, pages visited, and similar technical information.</li></ul>
<h2>2. How We Use Your Information</h2><ul>
<li>To provide, operate, and support the ${B} service</li><li>To process payments and send account and billing notices</li><li>To send marketing messages only where you have separately opted in</li><li>To comply with legal obligations and facility rules</li></ul>
<h2>3. Sharing Your Information</h2><p>We share information only with service providers who assist in our operations (payment processing, hosting, telecommunications carriers, and the facility messaging platform you direct us to use), and with legal authorities when required by law. We do not sell your personal information.</p>
<h2>4. SMS/Text Messaging Privacy</h2><p>Our signup form provides two separate opt-in checkboxes for SMS/text messaging:</p><ul>
<li><strong>Service SMS:</strong> new-message alerts relayed from your contact, delivery confirmations for your replies, and account and billing updates. You can reply to these texts to send a message back through ${B}. You opt in by checking the Service SMS checkbox on our form.</li>
<li><strong>Marketing SMS:</strong> product updates and offers from ${B}. You opt in by checking the Marketing SMS checkbox on our form.</li>
<li><strong>Mobile information will not be sold or shared with third parties/affiliates for marketing or promotional purposes.</strong></li>
<li>All the above categories exclude text messaging originator opt-in data and consent; this information will not be sold or shared with any third parties.</li>
<li>You may opt out of either or both message types at any time by replying STOP to any message. Reply HELP for help.</li>
<li>Message and data rates may apply. Message frequency varies.</li></ul>
<h2>5. Your Rights and Choices</h2><ul><li>Access, correct, or delete your personal information by emailing <a href="mailto:${E}">${E}</a></li><li>Opt out of marketing communications at any time</li><li>Opt out of SMS messages by replying STOP</li></ul>
<h2>6. Data Security</h2><p>We use reasonable administrative, technical, and physical safeguards, including encryption of stored credentials. No method of transmission over the Internet is 100% secure.</p>
<h2>7. Children's Privacy</h2><p>Our services are not directed to individuals under 18 years of age.</p>
<h2>8. Changes to This Policy</h2><p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated revision date.</p>
<h2>9. Governing Law</h2><p>This Privacy Policy is governed by the laws of the State of ${esc(LEGAL.state)}.</p>
<h2>10. Contact Us</h2><p>${L}<br>Email: <a href="mailto:${E}">${E}</a></p></article>`;
  return shell('Privacy Policy', body);
}

export function renderTerms() {
  const B = esc(LEGAL.brand), L = esc(LEGAL.legalName), E = esc(LEGAL.supportEmail);
  const body = `<article class="doc"><h1>Terms of Service</h1><p class="updated">Last updated: ${monthYear()}</p>
<p>Welcome to ${B}, operated by ${L}. By accessing or using foxvox.ai and the ${B} service, you agree to be bound by these Terms of Service ("Terms").</p>
<h2>1. Acceptance of Terms</h2><p>By creating an account or using our services you acknowledge that you have read, understood, and agree to these Terms.</p>
<h2>2. Services Description</h2><p>${B} is a subscription service that relays correspondence between you and an incarcerated contact through the facility's approved messaging platform, using the platform account you create or authorize. ${B} may also generate draft replies with your direction and notify you by SMS when you have opted in.</p>
<h2>3. User Responsibilities</h2><ul><li>Provide accurate and complete information</li><li>Use the service only for lawful purposes and in compliance with the rules of the facility and its messaging platform</li><li>Keep your account secure and notify us of unauthorized use</li><li>Not interfere with the proper functioning of the service</li></ul>
<h2>4. SMS/Text Messaging Terms</h2><p>${B} offers two separate SMS consent options on our signup form. By checking the corresponding checkbox, you agree to the following:</p><ul>
<li><strong>Service SMS:</strong> new-message alerts relayed from your contact, delivery confirmations for your replies, and account and billing updates. You can reply to these texts to send a message back through ${B}. Message frequency may vary.</li>
<li><strong>Marketing SMS:</strong> product updates and offers. Message frequency varies.</li>
<li>Message and data rates may apply depending on your mobile carrier plan</li>
<li>You may opt out of either or both message types at any time by replying STOP to any message</li>
<li>For assistance, reply HELP to any message or contact us at <a href="mailto:${E}">${E}</a></li>
<li>Consent to receive text messages is not a condition of purchasing any product or service</li>
<li>Carriers are not liable for delayed or undelivered messages</li></ul>
<h2>5. Payments and Refunds</h2><p>Plans are billed monthly in advance and renew until cancelled. Included message allowances reset each billing cycle; additional messages are billed at the published per-message rate. Platform fees charged by the facility's messaging provider (for example, message stamps) are separate and may be purchased on your behalf with your authorization. Contact <a href="mailto:${E}">${E}</a> for billing questions or refund requests.</p>
<h2>6. Intellectual Property</h2><p>All content on this website is the property of ${L} or its licensors.</p>
<h2>7. Limitation of Liability</h2><p>To the fullest extent permitted by law, ${L} shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising out of your use of the service, including delayed or undelivered messages.</p>
<h2>8. Modifications</h2><p>We may modify these Terms at any time. Changes are effective upon posting.</p>
<h2>9. Governing Law</h2><p>These Terms are governed by the laws of the State of ${esc(LEGAL.state)}.</p>
<h2>10. Contact</h2><p>${L}<br>Email: <a href="mailto:${E}">${E}</a></p></article>`;
  return shell('Terms of Service', body);
}

export const html = (s, status = 200, extra = {}) => new Response(s, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...extra } });

export function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}
