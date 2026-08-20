// Transactional email via the Gmail API as the FoxVox mailbox (foxone@foxvox.ai),
// authorized once with an OAuth refresh token (scripts/google-oauth-bootstrap.mjs).
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, MAIL_FROM.
// If any is missing, sendMail() returns {skipped:true} — callers treat mail as best-effort.
import { esc } from './pages.mjs';

export function mailConfigured(env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN); }

async function accessToken(env) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('google token: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}

const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function buildMime({ from, to, subject, text, html }) {
  const boundary = 'fv' + Math.random().toString(36).slice(2);
  const enc = (s) => '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(s))) + '?=';
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text, '',
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', html, '',
    `--${boundary}--`, '',
  ].join('\r\n');
}

export async function sendMail(env, { to, subject, text, html }) {
  if (!mailConfigured(env)) return { skipped: true, reason: 'mail not configured' };
  const from = env.MAIL_FROM || 'FoxVox <foxone@foxvox.ai>';
  const token = await accessToken(env);
  const raw = b64url(buildMime({ from, to, subject, text, html: html || `<pre style="font:15px/1.5 -apple-system,sans-serif;white-space:pre-wrap">${esc(text)}</pre>` }));
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('gmail send: ' + (j.error?.message || r.status));
  return { ok: true, id: j.id };
}

// ── Templates (plain, specific, no marketing voice) ──
const wrap = (title, bodyHtml) => `<!doctype html><body style="margin:0;background:#0A0A0A;padding:24px;font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#fff">
<div style="max-width:560px;margin:0 auto;background:#171717;border:1px solid rgba(255,107,26,.25);border-radius:14px;padding:28px">
<div style="font-weight:800;letter-spacing:.04em;margin-bottom:18px"><span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:linear-gradient(135deg,#FF6B1A,#FFB347);vertical-align:-1px;margin-right:8px"></span>FoxVox</div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}
<p style="color:#6b6b6b;font-size:12px;margin-top:24px">FoxVox · foxone@foxvox.ai · <a style="color:#A8A8A8" href="https://foxvox.ai/account">My account</a></p></div></body>`;
const btn = (href, label) => `<p style="margin:20px 0"><a href="${esc(href)}" style="background:linear-gradient(135deg,#FF6B1A,#E84D0E);color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px;display:inline-block">${esc(label)}</a></p>`;

export function welcomeEmail({ email, accountUrl }) {
  const subject = 'Welcome to FoxVox — next step: connect your contact';
  const text = `Welcome to FoxVox.

Your plan is active: $29/month, 60 messages included.

Next step — connect your contact's messaging account:
1. Reply to this email with (a) your contact's full name and ID on the facility platform, (b) the facility/state, and (c) whether you already have an account on the platform or want us to set one up.
2. We'll confirm within one business day and turn the relay on.

Your account: ${accountUrl}

If you opted in to texts, you can reply STOP at any time to opt out.
— FoxVox · foxone@foxvox.ai`;
  const html = wrap('Welcome to FoxVox', `<p style="color:#ddd">Your plan is active: <b>$29/month</b>, 60 messages included.</p>
<p style="color:#ddd"><b>Next step — connect your contact's messaging account.</b> Reply to this email with:</p>
<ol style="color:#ddd;line-height:1.7"><li>your contact's full name and ID on the facility platform</li><li>the facility / state</li><li>whether you already have an account on the platform or want us to set one up</li></ol>
<p style="color:#ddd">We'll confirm within one business day and turn the relay on.</p>${btn(accountUrl, 'Open my account')}
<p style="color:#A8A8A8;font-size:13px">If you opted in to texts, reply STOP to any text to opt out.</p>`);
  return { to: email, subject, text, html };
}

export function loginEmail({ email, loginUrl }) {
  const subject = 'Your FoxVox sign-in link';
  const text = `Here is your sign-in link for FoxVox (valid 20 minutes):\n\n${loginUrl}\n\nIf you didn't request this, ignore this email.\n— FoxVox`;
  const html = wrap('Sign in to FoxVox', `<p style="color:#ddd">Use this link to open your account. It works once and expires in 20 minutes.</p>${btn(loginUrl, 'Sign in')}<p style="color:#A8A8A8;font-size:13px">If you didn't request this, you can ignore this email.</p>`);
  return { to: email, subject, text, html };
}
