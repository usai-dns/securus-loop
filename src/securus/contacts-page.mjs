// eMessaging contacts page automation — built from read-only recon 2026-08-20
// (#/products/emessage/contacts): table [Contact, ID, Site, BLOCKED]; "Add Contact"
// button opens an inline search form: radio formcontrolname="type" (Name | ID),
// firstName/lastName (Name mode) or inmateId "Number (JID)" (ID mode),
// select[formcontrolname="state"] (2-letter values), select[formcontrolname="siteid"]
// (agency; populated after state, e.g. "Colorado" = Colorado State Prison System),
// button "Search" → results table [Name, ID, Site, Action] with a per-row
// "Add Contact" button (THE record-creating click — gated behind `confirm`).
import { humanDelay, safeGoto, log } from './helpers.mjs';

export const CONTACTS_URL = 'https://securustech.online/#/products/emessage/contacts';
const SEL = {
  addContactBtn: 'button',                  // text match "Add Contact"
  typeRadios: 'input[type="radio"][formcontrolname="type"]',
  firstName: 'input[formcontrolname="firstName"]',
  lastName: 'input[formcontrolname="lastName"]',
  inmateId: 'input[formcontrolname="inmateId"]',
  state: 'select[formcontrolname="state"]',
  agency: 'select[formcontrolname="siteid"]',
};

export async function gotoContacts(page) {
  await safeGoto(page, CONTACTS_URL);
  await humanDelay(2500, 3500);
  await page.waitForSelector('table', { timeout: 20000 }).catch(() => {});
}

// Existing (approved) contacts on the account.
export async function listContacts(page) {
  await gotoContacts(page);
  return page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find((tb) => /contact/i.test(tb.querySelector('th')?.textContent || ''));
    if (!t) return [];
    return [...t.querySelectorAll('tbody tr')].map((tr) => {
      const c = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
      return { name: c[0] || '', id: c[1] || '', site: c[2] || '', blocked: !!(c[3] && c[3].trim()) };
    }).filter((r) => r.name);
  });
}

async function clickButtonWithText(page, text) {
  return page.evaluate((t) => {
    const b = [...document.querySelectorAll('button, a.button')].find((el) => (el.textContent || '').trim().toLowerCase() === t.toLowerCase() && (el.offsetWidth || el.offsetHeight));
    if (!b || b.disabled) return false; b.click(); return true;
  }, text);
}

async function openAddForm(page) {
  await gotoContacts(page);
  const present = await page.$(SEL.state);
  if (!present) {
    const ok = await clickButtonWithText(page, 'Add Contact');
    if (!ok) throw new Error('Add Contact button not found');
    await humanDelay(2000, 3000);
    await page.waitForSelector(SEL.state, { timeout: 15000 });
  }
}

// Agencies (facility systems) for a state, as shown in the Add Contact form.
export async function listAgencies(page, state) {
  await openAddForm(page);
  await page.select(SEL.state, state);
  await humanDelay(2500, 3500);
  return page.evaluate((sel) => [...document.querySelector(sel).options].map((o) => ({ value: o.value, text: o.textContent.trim() })).filter((o) => o.value), SEL.agency);
}

// Search (read-only). q = { mode:'name'|'id', firstName, lastName, inmateId, state, agency }
export async function searchInmates(page, q) {
  await openAddForm(page);
  const mode = q.mode === 'id' ? 'id' : 'name';
  await page.evaluate((sel, m) => {
    const radios = [...document.querySelectorAll(sel)];
    const r = radios.find((x) => ((x.labels?.[0]?.textContent) || '').trim().toLowerCase() === m) || radios[m === 'id' ? 1 : 0];
    if (r && !r.checked) r.click();
  }, SEL.typeRadios, mode);
  await humanDelay(600, 1000);
  if (mode === 'id') {
    await page.waitForSelector(SEL.inmateId, { timeout: 10000 });
    await page.click(SEL.inmateId, { clickCount: 3 }); await page.type(SEL.inmateId, String(q.inmateId || '').trim(), { delay: 40 });
  } else {
    await page.click(SEL.firstName, { clickCount: 3 }); await page.type(SEL.firstName, String(q.firstName || '').trim(), { delay: 40 });
    await page.click(SEL.lastName, { clickCount: 3 }); await page.type(SEL.lastName, String(q.lastName || '').trim(), { delay: 40 });
  }
  await page.select(SEL.state, q.state);
  await humanDelay(2500, 3500);
  const agencies = await page.evaluate((sel) => [...document.querySelector(sel).options].map((o) => ({ value: o.value, text: o.textContent.trim() })).filter((o) => o.value), SEL.agency);
  const agency = agencies.find((a) => a.value === q.agency) || agencies.find((a) => a.text.toLowerCase() === String(q.agency || '').toLowerCase());
  if (!agency) throw new Error(`agency "${q.agency}" not offered for state ${q.state}`);
  await page.select(SEL.agency, agency.value);
  await humanDelay(800, 1200);
  const clicked = await clickButtonWithText(page, 'Search');
  if (!clicked) throw new Error('Search button not clickable (form incomplete?)');
  await humanDelay(4000, 6000);
  const results = await page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find((tb) => /action/i.test([...tb.querySelectorAll('th')].map((th) => th.textContent).join(' ')));
    if (!t) return { rows: [], noResultsText: (document.body.innerText.match(/no (results|records|inmates?) (found|match)[^\n]*/i) || [null])[0] };
    return { rows: [...t.querySelectorAll('tbody tr')].map((tr, i) => { const c = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()); return { index: i, name: c[0] || '', id: c[1] || '', site: c[2] || '', action: c[3] || '' }; }) };
  });
  return { query: { ...q, agencyText: agency.text }, agencies, ...results };
}

// Add a contact from a search result. STAGED: clicks the row's "Add Contact" only
// when `targetId` matches exactly one row; captures whatever modal appears; clicks
// a confirmation button only when `confirm === true` AND the modal offers exactly
// one affirmative button. Returns a full trace for the operator to review.
export async function addContactFromSearch(page, q, targetId, { confirm = false } = {}) {
  const search = await searchInmates(page, q);
  const matches = search.rows.filter((r) => r.id === String(targetId));
  if (matches.length !== 1) return { success: false, stage: 'search', reason: `expected exactly one result with id ${targetId}, got ${matches.length}`, search };
  const row = matches[0];
  const clicked = await page.evaluate((idx) => {
    const t = [...document.querySelectorAll('table')].find((tb) => /action/i.test([...tb.querySelectorAll('th')].map((th) => th.textContent).join(' ')));
    const tr = t && [...t.querySelectorAll('tbody tr')][idx];
    const b = tr && [...tr.querySelectorAll('button, a')].find((el) => /add contact/i.test(el.textContent || ''));
    if (!b) return false; b.click(); return true;
  }, row.index);
  if (!clicked) return { success: false, stage: 'click', reason: 'row Add Contact button not found', search };
  log('CONTACTS', `clicked Add Contact for ${row.name} (${row.id})`);
  await humanDelay(3000, 4500);
  const after = await page.evaluate(() => ({
    url: location.href,
    modals: [...document.querySelectorAll('.reveal-overlay, .reveal, [class*="modal"]')].filter((m) => m.offsetWidth || m.offsetHeight).map((m) => ({ text: (m.innerText || '').slice(0, 1500), buttons: [...m.querySelectorAll('button, a.button')].map((b) => (b.textContent || '').trim()).filter(Boolean) })),
    alerts: [...document.querySelectorAll('.alert, .callout, [role="alert"], .success, .error')].map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 400).slice(0, 8),
    bodyText: (document.body.innerText || '').slice(0, 1500),
  }));
  const modal = after.modals.find((m) => !/online assistant|let's chat/i.test(m.text));
  let confirmed = false, confirmButton = null;
  if (modal) {
    const affirmative = modal.buttons.filter((b) => /^(confirm|yes|ok|add|add contact|submit|continue)$/i.test(b));
    const negative = modal.buttons.filter((b) => /^(cancel|no|close|×)$/i.test(b));
    if (confirm && affirmative.length === 1) {
      confirmButton = affirmative[0];
      confirmed = await page.evaluate((t) => { const m = [...document.querySelectorAll('.reveal-overlay, .reveal, [class*="modal"]')].find((x) => x.offsetWidth || x.offsetHeight); const b = m && [...m.querySelectorAll('button, a.button')].find((el) => (el.textContent || '').trim() === t); if (!b) return false; b.click(); return true; }, confirmButton);
      await humanDelay(3000, 4500);
    } else if (!confirm) {
      // leave the modal for the operator; dismiss with a negative button to avoid a half-state
      const neg = negative[0];
      if (neg) await page.evaluate((t) => { const m = [...document.querySelectorAll('.reveal-overlay, .reveal, [class*="modal"]')].find((x) => x.offsetWidth || x.offsetHeight); const b = m && [...m.querySelectorAll('button, a.button')].find((el) => (el.textContent || '').trim() === t); if (b) b.click(); }, neg).catch(() => {});
    }
  }
  const contactsAfter = await listContacts(page).catch(() => []);
  const nowPresent = contactsAfter.some((c) => c.id === String(targetId));
  return { success: nowPresent, stage: modal ? (confirmed ? 'confirmed' : 'modal-pending') : 'clicked', row, modal: modal || null, confirmed, confirmButton, alerts: after.alerts, nowPresent, contactsAfter, search: { query: search.query } };
}

// Compose recipient dropdown (value = Securus compose id, text = name).
export async function listComposeRecipients(page, composeUrl, dropdownSel, acceptTerms) {
  await page.goto(composeUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await humanDelay(2500, 3500);
  if (acceptTerms) await acceptTerms(page).catch(() => {});
  await page.waitForSelector(dropdownSel, { visible: true, timeout: 20000 });
  return page.evaluate((sel) => { const dd = document.querySelector(sel); return dd ? [...dd.options].map((o) => ({ value: o.value, text: (o.textContent || '').trim() })).filter((o) => o.value) : []; }, dropdownSel);
}
