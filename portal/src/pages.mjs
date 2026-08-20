// Public pages served by foxvox-portal on foxvox.ai. Plain HTML, one CSS block,
// FoxVox palette (orange on near-black). Consent copy comes from consent.mjs
// and is 10DLC-registered — do not paraphrase it.
import { SERVICE_CONSENT, MARKETING_CONSENT, LEGAL } from './consent.mjs';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const monthYear = () => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/Denver' });
const year = () => new Date().getFullYear();
export const PLAN = { price: 29, included: 60, overage: 0.5 };

const CSS = `
:root{--fox:#FF6B1A;--amber:#FFB347;--deep:#E84D0E;--bg:#0A0A0A;--bg2:#111;--surf:#171717;--line:rgba(255,107,26,.16);--tx:#fff;--tx2:#A8A8A8;--mute:#6b6b6b;--ok:#5fd38d}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{font-family:"Plus Jakarta Sans",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--tx);line-height:1.6;min-height:100vh}
a{color:var(--amber)}
.mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace}
header{padding:1rem 1.5rem;border-bottom:1px solid var(--line);background:rgba(10,10,10,.85);backdrop-filter:blur(8px);position:sticky;top:0;z-index:5}
.nav{max-width:1040px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:1rem}
.logo{display:flex;align-items:center;gap:.6rem;color:#fff;text-decoration:none;font-weight:800;letter-spacing:.04em;font-size:1.1rem}
.logo i{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,var(--fox),var(--amber));display:inline-block;box-shadow:0 0 18px rgba(255,107,26,.35)}
.nav nav{display:flex;align-items:center;gap:1.1rem}
.nav nav a{color:var(--tx2);text-decoration:none;font-size:.9rem}
.nav nav a.cta{color:#fff;background:linear-gradient(135deg,var(--fox),var(--deep));padding:.5rem .9rem;border-radius:9px;font-weight:700}
@media(max-width:560px){.nav nav a.hide-m{display:none}}
main{max-width:1040px;margin:0 auto;padding:2.5rem 1.5rem 4rem}
.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:3rem;align-items:center;padding:2rem 0 3rem}
@media(max-width:820px){.hero{grid-template-columns:1fr;gap:2rem}}
.eyebrow{color:var(--amber);font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
h1{font-size:clamp(2rem,4.6vw,3.1rem);line-height:1.08;font-weight:800;letter-spacing:-.02em;margin:.6rem 0 1rem}
h1 span{color:var(--fox)}
.lead{color:var(--tx2);font-size:1.08rem;max-width:560px}
.actions{display:flex;gap:.8rem;flex-wrap:wrap;margin-top:1.5rem;align-items:center}
.btn{display:inline-block;background:linear-gradient(135deg,var(--fox),var(--deep));color:#fff;text-decoration:none;border:0;border-radius:10px;padding:.85rem 1.3rem;font-size:1rem;font-weight:700;cursor:pointer}
.btn:hover{filter:brightness(1.08)}
.btn.ghost{background:transparent;border:1px solid #333;color:#fff}
.note{color:var(--mute);font-size:.85rem}
/* relay demo */
.relay{background:var(--surf);border:1px solid var(--line);border-radius:18px;padding:1.2rem;position:relative;overflow:hidden}
.relay .lbl{display:flex;justify-content:space-between;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--mute);margin-bottom:.8rem}
.thread{display:flex;flex-direction:column;gap:.6rem}
.msg{max-width:86%;padding:.65rem .85rem;border-radius:14px;font-size:.92rem;line-height:1.45;opacity:0;transform:translateY(6px);animation:pop .5s ease forwards}
.msg.in{background:#222;border-bottom-left-radius:4px;align-self:flex-start}
.msg.out{background:linear-gradient(135deg,var(--fox),var(--deep));border-bottom-right-radius:4px;align-self:flex-end}
.msg small{display:block;color:rgba(255,255,255,.6);font-size:.72rem;margin-top:.25rem}
.msg:nth-child(1){animation-delay:.3s}.msg:nth-child(2){animation-delay:1.6s}.msg:nth-child(3){animation-delay:3s}.msg:nth-child(4){animation-delay:4.4s}
.wire{height:2px;background:linear-gradient(90deg,transparent,var(--fox),transparent);margin:.9rem 0 .3rem;position:relative;opacity:.8}
.wire::after{content:"";position:absolute;top:-3px;left:0;width:8px;height:8px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px var(--amber);animation:travel 2.2s linear infinite}
@keyframes pop{to{opacity:1;transform:none}}
@keyframes travel{0%{left:0}100%{left:calc(100% - 8px)}}
@media(prefers-reduced-motion:reduce){.msg{animation:none;opacity:1;transform:none}.wire::after{animation:none}}
section{padding:2.6rem 0;border-top:1px solid #1c1c1c}
h2{font-size:1.55rem;font-weight:800;letter-spacing:-.01em;margin-bottom:.4rem}
.sub{color:var(--tx2);max-width:620px;margin-bottom:1.6rem}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
@media(max-width:820px){.steps{grid-template-columns:1fr}}
.card{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:1.3rem}
.card h3{font-size:1.02rem;margin-bottom:.4rem}.card p{color:var(--tx2);font-size:.93rem}
.card .k{color:var(--amber);font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;font-weight:700;display:block;margin-bottom:.5rem}
.pricing{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem;align-items:start}
@media(max-width:820px){.pricing{grid-template-columns:1fr}}
.price{font-size:2.6rem;font-weight:800;letter-spacing:-.02em}.price small{font-size:1rem;color:var(--tx2);font-weight:600}
.inc{list-style:none;margin:1rem 0}.inc li{padding:.35rem 0;color:#ddd;border-bottom:1px dashed #242424}.inc li:last-child{border:0}
.faq details{border-bottom:1px solid #1c1c1c;padding:.8rem 0}.faq summary{cursor:pointer;font-weight:600;list-style:none}.faq summary::-webkit-details-marker{display:none}.faq p{color:var(--tx2);margin-top:.5rem;font-size:.95rem}
/* forms */
.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:2.2rem;margin-top:1.8rem;align-items:start}
@media(max-width:800px){.grid{grid-template-columns:1fr}}
.form h2{font-size:1.15rem;margin-bottom:.8rem}
label.f{display:block;font-size:.85rem;color:var(--tx2);margin:.9rem 0 .3rem}
input[type=text],input[type=email],input[type=tel]{width:100%;background:#0d0d0d;border:1px solid #2a2a2a;color:#fff;border-radius:9px;padding:.7rem .8rem;font-size:1rem}
input:focus{outline:2px solid var(--fox);outline-offset:1px;border-color:var(--fox)}
.consent{display:flex;gap:.65rem;align-items:flex-start;font-size:.8rem;color:var(--tx2);margin-top:.9rem;line-height:1.5}
.consent input{margin-top:3px;flex-shrink:0;width:16px;height:16px;accent-color:var(--fox)}
.links{font-size:.8rem;margin-top:.8rem;color:var(--mute)}.links a{margin-right:1rem}
.form button.btn{margin-top:1.1rem;width:100%}
.fine{font-size:.78rem;color:var(--mute);margin-top:.9rem}
.err{color:#ff8a65;font-size:.9rem;background:rgba(255,107,26,.08);border:1px solid rgba(255,107,26,.3);border-radius:9px;padding:.6rem .8rem}
.how li{margin:.6rem 0;color:var(--tx2)}.how b{color:#fff}
.doc h1{font-size:2rem;margin-bottom:.25rem}.doc .updated{color:var(--mute);font-size:.9rem;margin-bottom:1.6rem}
.doc h2{font-size:1.15rem;color:var(--amber);margin:1.8rem 0 .5rem}.doc p,.doc li{color:#cfcfcf}.doc p{margin-bottom:.9rem}.doc ul{margin:.5rem 0 .9rem 1.3rem}.doc li{margin-bottom:.4rem}
.panel{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:1.6rem;max-width:640px;margin:1.5rem auto}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1.2rem;font-size:.95rem;margin:1rem 0}.kv dt{color:var(--mute)}.kv dd{color:#fff}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.75rem;font-weight:700;letter-spacing:.04em}
.badge.ok{background:rgba(95,211,141,.15);color:var(--ok)}.badge.warn{background:rgba(255,179,71,.15);color:var(--amber)}.badge.off{background:#2a2a2a;color:#bbb}
footer{border-top:1px solid var(--line);padding:1.5rem;text-align:center;color:var(--mute);font-size:.8rem}
footer a{color:var(--tx2);text-decoration:none;margin:0 .5rem}`;

export function shell(title, body, { description = 'FoxVox relays messages between you and your incarcerated loved one — their messages reach your phone, your replies go back. $29/month.', noindex = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | ${esc(LEGAL.brand)}</title><meta name="description" content="${esc(description)}">${noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header><div class="nav"><a class="logo" href="/"><i></i>${esc(LEGAL.brand)}</a><nav><a class="hide-m" href="/#how">How it works</a><a class="hide-m" href="/#pricing">Pricing</a><a href="/account">My account</a><a class="cta" href="${LEGAL.signupPath}">Get started</a></nav></div></header>
<main>${body}</main>
<footer>&copy; ${year()} ${esc(LEGAL.legalName)}. All rights reserved. <a href="${LEGAL.privacyPath}">Privacy Policy</a> <a href="${LEGAL.termsPath}">Terms of Service</a> <a href="mailto:${LEGAL.supportEmail}">${LEGAL.supportEmail}</a></footer>
</body></html>`;
}

export function renderHome() {
  const body = `
<section class="hero" style="border:0">
  <div>
    <div class="eyebrow">For families of incarcerated loved ones</div>
    <h1>Their message, on your phone. <span>Your reply, back inside.</span></h1>
    <p class="lead">FoxVox watches the facility's messaging platform for you. When your person writes, the message arrives as a text. Reply to the text, and FoxVox sends it back through the platform — no daily logging in, no missed messages.</p>
    <div class="actions"><a class="btn" href="${LEGAL.signupPath}">Start for $${PLAN.price}/month</a><a class="btn ghost" href="#how">See how it works</a></div>
    <p class="note" style="margin-top:.9rem">${PLAN.included} messages included every month · cancel anytime · texts only if you opt in</p>
  </div>
  <div class="relay" aria-label="Example of a relayed conversation">
    <div class="lbl"><span>Facility platform</span><span>Your phone</span></div>
    <div class="thread">
      <div class="msg in">Hey — did the lawyer call back about the hearing date? Tell mom I'm okay.<small>from Sam · relayed by FoxVox</small></div>
      <div class="msg out">He called this morning. Hearing is the 14th. Mom says she loves you.<small>your text → sent back through the platform</small></div>
      <div class="msg in">That's a relief. Can you put $20 on commissary this week?<small>from Sam · relayed by FoxVox</small></div>
      <div class="msg out">Done tonight. Call Sunday?<small>delivered</small></div>
    </div>
    <div class="wire"></div>
    <div class="lbl" style="margin:0"><span class="mono">relay · secure</span><span class="mono">1 message = 1 stamp</span></div>
  </div>
</section>

<section id="how">
  <h2>How it works</h2>
  <p class="sub">Three things happen once, then FoxVox keeps running in the background.</p>
  <div class="steps">
    <div class="card"><span class="k">Connect</span><h3>Link your contact's messaging account</h3><p>Create a new account on the facility's platform or authorize your existing one. Credentials are stored encrypted; FoxVox only reads and sends messages for the contact you choose.</p></div>
    <div class="card"><span class="k">Relay</span><h3>Messages reach your phone</h3><p>New messages arrive as a text (if you opt in). Reply to the text and FoxVox sends it back through the platform, using your account's stamps.</p></div>
    <div class="card"><span class="k">Fund</span><h3>One plan, no surprises</h3><p>$${PLAN.price} a month covers ${PLAN.included} outbound messages. Need more? $${PLAN.overage.toFixed(2)} each. Manage or cancel your plan any time from your account.</p></div>
  </div>
</section>

<section id="pricing">
  <h2>Pricing</h2>
  <p class="sub">One plan per contact. No setup fee, no contract.</p>
  <div class="pricing">
    <div class="card"><div class="price">$${PLAN.price}<small> / month</small></div>
      <ul class="inc"><li>${PLAN.included} outbound messages included each month</li><li>Unlimited inbound relays to your phone</li><li>$${PLAN.overage.toFixed(2)} per message beyond ${PLAN.included}</li><li>Stamp purchases on the platform are passed through at cost</li><li>Cancel anytime — you keep what's left of the month</li></ul>
      <a class="btn" href="${LEGAL.signupPath}">Create your account</a></div>
    <div class="card"><h3>What a "message" is</h3><p>One message = one send on the facility's platform = one stamp. Most families use 20–30 a month; ${PLAN.included} leaves room for the busy weeks.</p><h3 style="margin-top:1rem">Who this is for</h3><p>Anyone with an approved contact on a supported facility messaging platform. FoxVox works alongside your existing account — nothing changes for your loved one inside.</p></div>
  </div>
</section>

<section class="faq">
  <h2>Questions</h2>
  <details><summary>Does my loved one know FoxVox is involved?</summary><p>That's up to you — many families tell them. Messages are sent from your account, as you, and you see every message in your FoxVox account.</p></details>
  <details><summary>Do I have to receive texts?</summary><p>No. Texts are optional and you choose them on the signup form. You can also read and reply from your FoxVox account on the web. Reply STOP to any text to opt out.</p></details>
  <details><summary>What about the platform's own fees?</summary><p>Facility platforms charge per message ("stamps"). Those are separate from FoxVox and, with your authorization, FoxVox can top them up on your behalf at cost so messages never stall.</p></details>
  <details><summary>Is this allowed?</summary><p>FoxVox uses your own authorized account and follows the platform's rules for messaging. You stay responsible for what's sent, and you can pause or cancel at any time.</p></details>
  <details><summary>How do I cancel?</summary><p>From <a href="/account">My account</a> → Manage billing. Cancellation takes effect at the end of the paid month.</p></details>
</section>`;
  return shell('Messages from inside, on your phone', body);
}

export function renderSignup({ error = '', values = {}, code = '' } = {}) {
  const v = (k) => esc(values[k] || '');
  const body = `
<div class="eyebrow">Step 1 of 2 · account</div>
<h1 style="font-size:clamp(1.7rem,3.6vw,2.3rem)">Create your FoxVox account</h1>
<p class="lead">Next you'll set up the $${PLAN.price}/month plan on our secure checkout. Connecting your contact's messaging account comes after.</p>
<div class="grid">
<form class="card form" method="post" action="/api/signup" novalidate>
  <h2>Your details</h2>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <label class="f" for="name">Full name</label><input type="text" id="name" name="name" autocomplete="name" value="${v('name')}">
  <label class="f" for="email">Email</label><input type="email" id="email" name="email" autocomplete="email" required value="${v('email')}">
  <label class="f" for="phone">Mobile number</label><input type="tel" id="phone" name="phone" autocomplete="tel" placeholder="(720) 555-0100" value="${v('phone')}">
  <label class="f" for="code">Invite code <span style="color:var(--mute)">(optional)</span></label><input type="text" id="code" name="code" autocomplete="off" value="${esc(code || values.code || '')}">
  <label class="consent"><input type="checkbox" id="serviceConsent" name="serviceConsent" value="1"><span>${esc(SERVICE_CONSENT)}</span></label>
  <label class="consent"><input type="checkbox" id="marketingConsent" name="marketingConsent" value="1"><span>${esc(MARKETING_CONSENT)}</span></label>
  <div class="links"><a href="${LEGAL.privacyPath}">Privacy Policy</a><a href="${LEGAL.termsPath}">Terms of Service</a></div>
  <button type="submit" class="btn">Continue to payment</button>
  <p class="fine">Consent to receive text messages is not a condition of purchase. Message and data rates may apply. Reply STOP to opt out, HELP for help.</p>
</form>
<aside class="card"><h2 style="font-size:1.05rem;margin-bottom:.6rem">What happens next</h2>
<ol class="how">
<li><b>Payment</b> — secure checkout by Stripe. $${PLAN.price}/month, ${PLAN.included} messages included, cancel anytime.</li>
<li><b>Connect</b> — we email you the steps to link or create your contact's messaging account.</li>
<li><b>Relay</b> — messages start flowing to your phone (if you opted in) and to your FoxVox account.</li></ol>
<p class="note" style="margin-top:.8rem">Already have an account? <a href="/account">Sign in</a>.</p>
</aside></div>`;
  return shell('Create your account', body);
}

export function renderWelcome({ email, status, subscriptionStatus } = {}) {
  const paid = status === 'complete' || status === 'paid';
  const body = `<div class="panel">
<div class="eyebrow">Step 2 of 2 · ${paid ? 'done' : 'payment'}</div>
<h1 style="font-size:1.8rem;margin:.4rem 0 .6rem">${paid ? 'Welcome to FoxVox.' : 'Almost there.'}</h1>
<p style="color:var(--tx2)">${paid ? `Your plan is active${email ? ` for <b style="color:#fff">${esc(email)}</b>` : ''}. Check your email for the next step — connecting your contact's messaging account.` : 'We have not received a completed payment for this session yet. If you just paid, refresh in a moment.'}</p>
<dl class="kv"><dt>Plan</dt><dd>$${PLAN.price}/month · ${PLAN.included} messages included</dd><dt>Billing</dt><dd>${esc(subscriptionStatus || (paid ? 'active' : 'pending'))}</dd></dl>
<div class="actions"><a class="btn" href="/account">Go to my account</a><a class="btn ghost" href="/">Back to home</a></div>
<p class="fine">If you opted in to texts, you can reply STOP at any time to opt out.</p></div>`;
  return shell(paid ? 'Welcome' : 'Payment pending', body, { noindex: true });
}

export function renderAccount({ payer, subscription, credits, signup, error, portalError, stripePortalLoginUrl } = {}) {
  if (!payer) {
    const body = `<div class="panel"><h1 style="font-size:1.7rem;margin-bottom:.5rem">My account</h1>
<p style="color:var(--tx2)">Sign in with the email you used at checkout and we'll send you a secure link. Billing (cards, invoices, cancel) is managed by Stripe.</p>
${error ? `<p class="err" style="margin-top:.8rem">${esc(error)}</p>` : ''}
<div class="actions" style="margin-top:1.2rem">${stripePortalLoginUrl ? `<a class="btn" href="${esc(stripePortalLoginUrl)}">Manage billing</a>` : ''}<a class="btn ghost" href="${LEGAL.signupPath}">Create an account</a></div>
<p class="fine">Just paid? Open the link in your welcome email, or return to the page Stripe sent you to after checkout.</p></div>`;
    return shell('My account', body, { noindex: true });
  }
  const st = subscription?.status || 'none';
  const badge = st === 'active' || st === 'trialing' ? 'ok' : st === 'past_due' || st === 'unpaid' ? 'warn' : 'off';
  const renew = subscription?.current_period_end ? new Date(subscription.current_period_end * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const body = `<div class="panel">
<div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap"><h1 style="font-size:1.7rem">My account</h1><span class="badge ${badge}">${esc(st)}</span></div>
<dl class="kv"><dt>Email</dt><dd>${esc(payer.email)}</dd><dt>Plan</dt><dd>$${PLAN.price}/month · ${PLAN.included} messages included</dd><dt>${subscription?.cancel_at_period_end ? 'Ends' : 'Renews'}</dt><dd>${renew}</dd><dt>Message credits</dt><dd class="mono">${Number(credits ?? 0)}</dd><dt>Texts</dt><dd>${signup?.service_sms_consent ? 'Service texts on' : 'Service texts off'}${signup?.marketing_sms_consent ? ' · marketing on' : ''}</dd></dl>
${portalError ? `<p class="err">${esc(portalError)}</p>` : ''}
<form method="post" action="/api/account/portal" class="actions"><button class="btn" type="submit">Manage billing</button><a class="btn ghost" href="/api/account/logout">Sign out</a></form>
<h2 style="font-size:1.05rem;margin-top:1.6rem">Next: connect your contact</h2>
<p style="color:var(--tx2);font-size:.95rem">We'll email you the steps to link or create your contact's messaging account. Questions? <a href="mailto:${LEGAL.supportEmail}">${LEGAL.supportEmail}</a></p></div>`;
  return shell('My account', body, { noindex: true });
}

export function renderNotice(title, message, { cta, href } = {}) {
  return shell(title, `<div class="panel"><h1 style="font-size:1.6rem;margin-bottom:.5rem">${esc(title)}</h1><p style="color:var(--tx2)">${esc(message)}</p>${cta ? `<div class="actions"><a class="btn" href="${esc(href || '/')}">${esc(cta)}</a></div>` : ''}</div>`, { noindex: true });
}

export function renderPrivacy() {
  const B = esc(LEGAL.brand), L = esc(LEGAL.legalName), E = esc(LEGAL.supportEmail);
  const body = `<article class="doc"><h1>Privacy Policy</h1><p class="updated">Last updated: ${monthYear()}</p>
<p>${L} ("${B}," "we," "us," or "our") respects your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you visit foxvox.ai or use the ${B} service.</p>
<h2>1. Information We Collect</h2><ul>
<li><strong>Personal data:</strong> name, email address, mobile phone number, and billing details you provide when creating an account or purchasing. Payments are processed by Stripe; we do not store card numbers.</li>
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
<h2>5. Payments and Refunds</h2><p>Plans are billed monthly in advance through Stripe and renew until cancelled. Each plan includes ${PLAN.included} outbound messages per billing cycle; additional messages are billed at $${PLAN.overage.toFixed(2)} each. Platform fees charged by the facility's messaging provider (for example, message stamps) are separate and may be purchased on your behalf with your authorization. Cancellation takes effect at the end of the current billing period. Contact <a href="mailto:${E}">${E}</a> for billing questions or refund requests.</p>
<h2>6. Intellectual Property</h2><p>All content on this website is the property of ${L} or its licensors.</p>
<h2>7. Limitation of Liability</h2><p>To the fullest extent permitted by law, ${L} shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising out of your use of the service, including delayed or undelivered messages.</p>
<h2>8. Modifications</h2><p>We may modify these Terms at any time. Changes are effective upon posting.</p>
<h2>9. Governing Law</h2><p>These Terms are governed by the laws of the State of ${esc(LEGAL.state)}.</p>
<h2>10. Contact</h2><p>${L}<br>Email: <a href="mailto:${E}">${E}</a></p></article>`;
  return shell('Terms of Service', body);
}

export const html = (s, status = 200, extra = {}) => new Response(s, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

export function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}
