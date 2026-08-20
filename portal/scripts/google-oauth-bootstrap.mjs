#!/usr/bin/env node
// One-time: obtain a Gmail refresh token for the sending mailbox (foxone@foxvox.ai)
// using the Web OAuth client JSON downloaded from Google Cloud.
//   node scripts/google-oauth-bootstrap.mjs ~/Downloads/client_secret_xxx.json
// Starts http://localhost:8787/oauth/callback, prints the consent URL, waits for
// the redirect, exchanges the code, and writes ../../secrets/google-mailer.json
// (OUTSIDE git). Then put the values into worker secrets:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, MAIL_FROM
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/google-oauth-bootstrap.mjs <client_secret.json>'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const c = raw.web || raw.installed;
if (!c) { console.error('not a Google OAuth client JSON'); process.exit(1); }
const REDIRECT = 'http://localhost:8787/oauth/callback';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../secrets/google-mailer.json');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
  access_type: 'offline', prompt: 'consent', login_hint: 'foxone@foxvox.ai',
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:8787');
  if (u.pathname !== '/oauth/callback') { res.writeHead(404); return res.end('nope'); }
  const code = u.searchParams.get('code');
  if (!code) { res.writeHead(400); return res.end('missing code: ' + (u.searchParams.get('error') || '')); }
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' }) });
  const tok = await tr.json();
  if (!tok.refresh_token) { res.writeHead(500); res.end('no refresh_token: ' + JSON.stringify(tok)); console.error(tok); return; }
  // who granted?
  const me = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } })).json().catch(() => ({}));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: tok.refresh_token, mail_from: me.email || 'foxone@foxvox.ai', scope: tok.scope, obtained_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h2>FoxVox mailer authorized' + (me.email ? ' as ' + me.email : '') + '. You can close this tab.</h2>');
  console.log('\n✅ refresh token saved →', out, '(granted by', me.email || 'unknown', ')');
  setTimeout(() => server.close(() => process.exit(0)), 300);
});
server.listen(8787, () => { console.log('Listening on ' + REDIRECT + '\n\nOpen this URL and click Allow as foxone@foxvox.ai:\n\n' + authUrl + '\n'); });
