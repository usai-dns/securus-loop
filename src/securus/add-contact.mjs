// Automated contact adding — STAGING (not deployed to production).
//
// Purpose: when the service is offered to people who don't know the Securus
// UI, the system should be able to add an inmate contact to a (tenant's)
// Securus account itself, instead of walking the customer through the UI.
//
// Same two-stage discipline as stamp purchasing:
//   1. RECON (this module, read-only): crawl the add-contact flow from
//      my-account, capture pages/forms/fields — never submit anything.
//   2. ADD (later): implemented only from recon-verified selectors, then
//      exercised supervised before any autonomous use. Adding a contact on
//      Securus can trigger facility approval workflows — a wrong submission
//      creates records we can't delete, so the no-guessing rule applies.
//
// Recon output shape (stored under state key `add_contact_recon`):
//   { ts, steps: [{ url, title, links, forms }] }

import { urls } from './selectors.mjs';
import { humanDelay, log } from './helpers.mjs';

async function capturePage(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].map(h => (h.textContent || '').trim()).filter(Boolean).slice(0, 10),
    links: [...document.querySelectorAll('a,button')]
      .map(el => ({ tag: el.tagName, text: (el.textContent || '').trim().substring(0, 60), href: el.getAttribute('href') }))
      .filter(l => l.text).slice(0, 60),
    forms: [...document.querySelectorAll('form')].map(f => ({
      action: f.getAttribute('action'),
      fields: [...f.querySelectorAll('input,select,textarea')].map(el => ({
        tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'),
        id: el.id || null, placeholder: el.getAttribute('placeholder'),
      })).slice(0, 25),
      buttons: [...f.querySelectorAll('button,[type="submit"]')].map(b => (b.textContent || b.value || '').trim()).filter(Boolean),
    })),
    bodyText: (document.body?.innerText || '').substring(0, 1800),
  }));
}

// Read-only crawl: my-account → any link that smells like contact management →
// one level deeper toward an "add contact" page. NEVER fills or submits.
export async function reconAddContactFlow(page) {
  const steps = [];

  await page.goto(urls.myAccount, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await humanDelay(2000, 3000);
  const home = await capturePage(page);
  steps.push(home);

  const contactLink = home.links.find(l =>
    l.href && /contact/i.test(`${l.text} ${l.href}`) && !/contact\s*us|support/i.test(l.text));
  if (contactLink?.href) {
    const dest = contactLink.href.startsWith('http')
      ? contactLink.href
      : `https://securustech.online/${contactLink.href.replace(/^\//, '')}`;
    log('RECON', `following contact link: "${contactLink.text}" → ${dest}`);
    await page.goto(dest, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    await humanDelay(2000, 3000);
    const contactsPage = await capturePage(page);
    steps.push(contactsPage);

    const addLink = contactsPage.links.find(l => /add|new/i.test(l.text) && /contact/i.test(`${l.text} ${l.href || ''}`))
      || contactsPage.links.find(l => /^add\b|^\+/i.test(l.text));
    if (addLink?.href) {
      const dest2 = addLink.href.startsWith('http')
        ? addLink.href
        : `https://securustech.online/${addLink.href.replace(/^\//, '')}`;
      log('RECON', `following add link: "${addLink.text}" → ${dest2}`);
      await page.goto(dest2, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
      await humanDelay(2000, 3000);
      steps.push(await capturePage(page));
    }
  }

  log('RECON', `add-contact recon captured ${steps.length} page(s)`);
  return { ts: new Date().toISOString(), steps };
}

// NOT IMPLEMENTED until add_contact_recon has been reviewed and the flow's
// selectors verified. Submitting a wrong add-contact request creates
// facility-side records we cannot undo — never best-guess this path.
export async function addContact(page, { inmateName, docNumber, facility }) {
  return {
    success: false,
    notImplemented: true,
    note: 'add-contact click-path pending recon-verified selectors (state: add_contact_recon)',
  };
}
