// securus message reading for cloudflare worker (puppeteer)

import { messageView as sel } from './selectors.mjs';
import { humanDelay, safeTextContent, log } from './helpers.mjs';

export async function openMessage(page, messageIndex) {
  log('READ', `opening message at index ${messageIndex}...`);

  // click subject cell (td:nth-child(2)) of the target row
  const rowSelector = `table tr:nth-child(${messageIndex + 2}) td:nth-child(2)`;
  await page.click(rowSelector);
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
  const backLink = await page.$(sel.backToInbox);
  if (backLink) {
    await backLink.click();
    await humanDelay(1500, 2500);
  }
}
