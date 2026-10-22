// Connect-your-contact flow pages (signed-in payers). Two paths converge on a
// verified Securus login → choose/add the contact to relay.
import { shell, esc } from './pages.mjs';
import { LEGAL } from './consent.mjs';

const US_STATES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming' };
const statusBadge = (s) => `<span class="badge ${s === 'connected' ? 'ok' : s === 'verified' || s === 'awaiting_account' || s === 'pending_approval' ? 'warn' : 'off'}">${esc(s || 'not connected')}</span>`;
const errBox = (e) => (e ? `<p class="err">${esc(e)}</p>` : '');
const stepBar = (n) => `<div class="eyebrow">Connect · step ${n} of 3</div>`;
const copyBtn = (v) => `<button type="button" class="btn ghost" style="width:auto;padding:.35rem .6rem;font-size:.8rem;margin:0 0 0 .5rem" onclick="navigator.clipboard&&navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy</button>`;

export function renderConnectHome({ conn, error } = {}) {
  const body = `<div class="panel" style="max-width:720px">
${stepBar(1)}<h1 style="font-size:1.7rem;margin:.3rem 0 .4rem">Connect your contact</h1>
<p style="color:var(--tx2)">FoxVox relays messages through the facility's messaging platform (Securus eMessaging). We need a Securus account that has your contact approved. Status: ${statusBadge(conn?.status)}</p>
${errBox(error)}
${conn?.status === 'connected' ? `<p style="color:var(--ok);margin-top:.8rem">Connected — relaying for <b>${esc(conn.contact_name || '')}</b>. <a href="/account">Back to my account</a></p>` : ''}
<div class="steps" style="grid-template-columns:1fr 1fr;margin-top:1.4rem">
  <a class="card" href="/connect/existing" style="text-decoration:none;color:inherit"><span class="k">I already have a Securus account</span><h3>Use my existing account</h3><p>You give FoxVox your Securus sign-in. We verify it works, show your approved contacts, and you pick who to relay. Credentials are encrypted at rest.</p></a>
  <a class="card" href="/connect/new" style="text-decoration:none;color:inherit"><span class="k">I don't have one yet</span><h3>Create a FoxVox-managed account</h3><p>FoxVox generates the password and security answers; you complete Securus's sign-up with your ID details (they require the account holder's identity) and we take it from there.</p></a>
</div>
<p class="fine">Your loved one must already be — or become — an approved contact on that account. Facilities approve contacts on their own schedule; FoxVox can submit the request for you.</p></div>`;
  return shell('Connect your contact', body, { noindex: true });
}

export function renderConnectExisting({ error, values = {} } = {}) {
  const body = `<div class="panel" style="max-width:640px">${stepBar(1)}<h1 style="font-size:1.6rem;margin:.3rem 0 .6rem">Use your existing Securus account</h1>
<p style="color:var(--tx2)">Enter the email and password you use