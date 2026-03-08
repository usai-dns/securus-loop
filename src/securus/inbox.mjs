// securus inbox navigation for cloudflare worker (puppeteer)

import { urls, postLogin, inbox as sel } from './selectors.mjs';
import { humanDelay, waitForHash, safeGoto, log } from './helpers.mjs';

export async function navigateToInbox(page) {
  log('INBOX', 'navigating to inbox...');

  // always use direct navigation — more reliable than clicking links
  await safeGoto(page, urls.inbox);

  await waitForHash(page, '#/products/emessage/inbox', 15000).catch(() => {
    log('INBOX', 'warning: hash did not change to inbox');
  });
  await humanDelay(2000, 3000);

  // wait for tbody rows to render (not just any tr — we need actual message rows)
  await page.waitForSelector('table tbody tr', { visible: true, timeout: 20000 }).catch(async () => {
    log('INBOX', 'table not rendered, reloading page...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(3000, 5000);
    await page.waitForSelector('table tbody tr', { visible: true, timeout: 20000 }).catch(() => {
      log('INBOX', 'ERROR: inbox table still did not render after reload');
    });
  });

  log('INBOX', `at inbox → ${page.url()}`);
}

export async function enumerateMessages(page) {
  log('INBOX', 'reading message list...');

  const messages = await page.evaluate(() => {
    // use tbody tr to get data rows — NOT tr:nth-child(n+2) which skips first tbody row
    const rows = document.querySelectorAll('table tbody tr');
    const results = [];
    rows.forEach((row, index) => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const sender = cells[0]?.textContent?.trim() || '';
        // prefer full subject from .hide-for-small-only span
        const subjectEl = cells[1]?.querySelector('.hide-for-small-only');
        const subject = subjectEl ? subjectEl.textContent?.trim() : cells[1]?.textContent?.trim() || '';
        const date = cells[2]?.textContent?.trim() || '';
        const isUnread = row.classList.contains('font-bold');
        results.push({ index, sender, subject, date, isUnread });
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
