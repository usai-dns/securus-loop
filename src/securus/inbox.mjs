// securus inbox navigation for cloudflare worker (puppeteer)

import { urls, postLogin, inbox as sel } from './selectors.mjs';
import { humanDelay, waitForHash, log } from './helpers.mjs';

export async function navigateToInbox(page) {
  log('INBOX', 'navigating to inbox...');

  // try clicking the inbox link first (works from my-account page)
  const inboxLink = await page.$(postLogin.launchInbox);
  if (inboxLink) {
    await inboxLink.click();
  } else {
    log('INBOX', 'no inbox link found, navigating directly...');
    await page.goto(urls.inbox, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  await waitForHash(page, '#/products/emessage/inbox', 15000).catch(() => {
    log('INBOX', 'warning: hash did not change to inbox');
  });
  await humanDelay(1500, 2500);

  // wait for the message table to render
  await page.waitForSelector('table tr:nth-child(2)', { visible: true, timeout: 15000 }).catch(() => {
    log('INBOX', 'warning: inbox table did not render');
  });

  log('INBOX', `at inbox → ${page.url()}`);
}

export async function enumerateMessages(page) {
  log('INBOX', 'reading message list...');

  const messages = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tr:nth-child(n+2)');
    const results = [];
    rows.forEach((row, index) => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const sender = cells[0]?.textContent?.trim() || '';
        // prefer full subject from .hide-for-small-only span
        const subjectEl = cells[1]?.querySelector('.hide-for-small-only');
        const subject = subjectEl ? subjectEl.textContent?.trim() : cells[1]?.textContent?.trim() || '';
        const date = cells[2]?.textContent?.trim() || '';
        results.push({ index, sender, subject, date });
      }
    });
    return results;
  });

  log('INBOX', `found ${messages.length} messages`);
  return messages;
}

export function findSamMessages(messages) {
  return messages.filter(m => m.sender?.includes('SAMUEL') || m.sender?.includes('MULLIKIN'));
}
