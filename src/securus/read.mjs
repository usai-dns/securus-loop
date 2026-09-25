// securus message reading for cloudflare worker (puppeteer)

import { messageView as sel, urls } from './selectors.mjs';
import { humanDelay, safeTextContent, inAppNav, log } from './helpers.mjs';

export async function openMessage(page, messageIndex) {
  log('READ', `opening message at index ${messageIndex}...`);

  // click subject cell (td:nth-child(2)) of the target row
  // tbody tr:nth-child is 1-based, so index 0 → nth-child(1)
  const rowSelector = `table tbody tr:nth-child(${messageIndex + 1}) td:nth-child(2)`;
  const el = await page.$(rowSelector);
  if (!el) {
    log('READ', `row not found: ${rowSelector} — skipping`);
    return null;
  }
  await el.click();
  await humanDelay(2000, 3000);

  // extract message ID from URL
  const url = page.url();
  const messageIdMatch = url.match(/messageId=(\d+)/);
  const messageId = messageIdMatch ? messageIdMatch[1] : null;

  log('READ', `message URL: ${url}`);
  log('READ', `message ID: ${messageId}`);

  return messageId;
}

export async function extractMessage(page) {
  const body = await safeTextContent(page, sel.messageBody);
  const sender = await safeTextContent(page, sel.senderName);

  log('READ', `from: ${sender}`);
  log('READ', `body length: ${body?.length || 0} chars`);

  return { sender, body };
}

export async function navigateBackToInbox(page) {
  // Sept 2026: the inbox deep link bounces to /my-account — whose profile
  // table satisfied the old "table rendered" check, so every row after the
  // first was clicked against the WRONG page and scans could only ever save
  // the top message. Return via the in-app Inbox nav instead.
  await inAppNav(page, urls, '^inbox\\b|emessage/inbox');
  await humanDelay(1500, 2500);
  if (!page.url().includes('inbox')) {
    log('READ', `back-to-inbox landed on ${page.url()} — retrying via LAUNCH`);
    await inAppNav(page, urls, '^inbox\\b|emessage/inbox');
  }
  await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 }).catch(() => {
    log('READ', 'warning: inbox table did not re-render after navigating back');
  });
}
