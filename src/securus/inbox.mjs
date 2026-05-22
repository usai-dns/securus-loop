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
  await page.waitForSelector('table tbody tr', { visible: true, timeout: 30000 }).catch(async () => {
    log('INBOX', 'table not rendered, reloading page...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await humanDelay(3000, 5000);
    await page.waitForSelector('table tbody tr', { visible: true, timeout: 30000 }).catch(() => {
      log('INBOX', 'ERROR: inbox table still did not render after reload');
    });
  });

  log('INBOX', `at inbox → ${page.url()}`);
}

export async function enumerateMessages(page) {
  log('INBOX', 'reading message list...');

  const messages = await readCurrentPage(page);
  log('INBOX', `found ${messages.length} messages on page 1`);
  return messages;
}

export async function enumerateAllPages(page) {
  log('INBOX', 'reading ALL inbox pages...');
  let allMessages = [];
  let pageNum = 1;
  const MAX_PAGES = 15;

  while (pageNum <= MAX_PAGES) {
    const pageMessages = await readCurrentPage(page);
    if (pageMessages.length === 0) break;

    for (const m of pageMessages) {
      m.page = pageNum;
      m.globalIndex = allMessages.length;
      allMessages.push(m);
    }
    log('INBOX', `page ${pageNum}: ${pageMessages.length} messages (${allMessages.length} total)`);

    const hasNext = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a')];
      const nextLink = links.find(a => {
        const text = (a.textContent?.trim() || '').toLowerCase();
        return text === '>' || text.startsWith('next') || text === '›' ||
               (a.getAttribute('aria-label') || '').toLowerCase().includes('next');
      });
      if (nextLink) { nextLink.click(); return true; }
      const pageLinks = links.filter(a => /^\d+$/.test(a.textContent?.trim()));
      const currentActive = document.querySelector('li.active a, a.active, span.active, a[disabled]');
      const currentNum = currentActive ? parseInt(currentActive.textContent?.trim()) : 0;
      const nextPageLink = pageLinks.find(a => parseInt(a.textContent?.trim()) === currentNum + 1);
      if (nextPageLink) { nextPageLink.click(); return true; }
      return false;
    });

    if (!hasNext) {
      log('INBOX', `no next page after page ${pageNum}`);
      break;
    }

    pageNum++;
    await humanDelay(2000, 3000);
    await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 }).catch(() => {});
  }

  log('INBOX', `total: ${allMessages.length} messages across ${pageNum} pages`);
  return allMessages;
}

function readCurrentPage(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    const results = [];
    rows.forEach((row, index) => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const sender = cells[0]?.textContent?.trim() || '';
        const subjectEl = cells[1]?.querySelector('.hide-for-small-only');
        const subject = subjectEl ? subjectEl.textContent?.trim() : cells[1]?.textContent?.trim() || '';
        const date = cells[2]?.textContent?.trim() || '';
        const isUnread = row.classList.contains('font-bold');
        results.push({ index, sender, subject, date, isUnread });
      }
    });
    return results;
  });
}

export function findSamMessages(messages) {
  return messages.filter(m => m.sender?.includes('SAMUEL') || m.sender?.includes('MULLIKIN'));
}
