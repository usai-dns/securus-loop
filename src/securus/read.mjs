// securus message reading for cloudflare worker (puppeteer)

import { messageView as sel } from './selectors.mjs';
import { humanDelay, safeTextContent, log } from './helpers.mjs';

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
  // direct navigation is more reliable than finding/clicking back links
  const { urls } = await import('./selectors.mjs');
  const { safeGoto } = await import('./helpers.mjs');
  await safeGoto(page, urls.inbox);
  await humanDelay(2000, 3000);
  // wait for table to re-render
  await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 }).catch(() => {
    log('READ', 'warning: inbox table did not re-render after navigating back');
  });
}
