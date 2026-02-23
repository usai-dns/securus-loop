require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

async function verifyReadMsg() {
  console.log('=== SECURUS MESSAGE READ (FOCUSED) ===\n');

  const { browser, page } = await launchBrowser(false);

  try {
    // === LOGIN + INBOX ===
    console.log('[1] logging in...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(1000, 2000);
    await page.fill('input[type="email"]', EMAIL);
    await humanDelay(300, 600);
    await page.fill('input[type="password"]', PASSWORD);
    await humanDelay(300, 600);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/my-account**', { timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);

    console.log('\n[2] navigating to inbox...');
    await page.click('a[href*="inbox"]');
    await page.waitForURL('**/emessage/inbox**', { timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);

    // === CLICK FIRST MESSAGE ROW (not the delete link!) ===
    console.log('\n[3] clicking first message row (subject cell)...');

    // click on the subject cell (td:nth-child(2)) of first data row to avoid delete button
    const subjectCell = await page.$('table tr:nth-child(2) td:nth-child(2)');
    if (!subjectCell) {
      console.log('  ERROR: no subject cell found');
      return;
    }

    const subjectText = await subjectCell.evaluate(e => e.textContent?.trim());
    console.log(`  subject: "${subjectText}"`);

    await humanDelay(500, 1000);
    await subjectCell.click();
    await humanDelay(3000, 4000);

    const msgUrl = page.url();
    console.log(`  message URL: ${msgUrl}`);
    await screenshot(page, 'readmsg-01-message-view');

    // === ANALYZE MESSAGE VIEW ===
    console.log('\n[4] analyzing message view...');

    // full page text
    const pageText = await page.evaluate(() => document.body?.innerText);
    console.log(`\n  === FULL PAGE TEXT ===\n${pageText?.substring(0, 3000)}\n  === END ===`);

    // look for specific structural elements
    const structureSearch = [
      { sel: 'h1, h2, h3, h4, h5', name: 'headings' },
      { sel: '[class*="subject"]', name: 'subject' },
      { sel: '[class*="from"]', name: 'from' },
      { sel: '[class*="sender"]', name: 'sender' },
      { sel: '[class*="date"]', name: 'date' },
      { sel: '[class*="body"]', name: 'body' },
      { sel: '[class*="message"]', name: 'message' },
      { sel: '[class*="content"]', name: 'content' },
      { sel: '[class*="detail"]', name: 'detail' },
      { sel: '[class*="thread"]', name: 'thread' },
      { sel: '[class*="reply"]', name: 'reply' },
      { sel: '[class*="attachment"]', name: 'attachment' },
      { sel: '[class*="photo"]', name: 'photo' },
      { sel: '[class*="image"]', name: 'image' },
      { sel: 'textarea', name: 'textarea' },
      { sel: 'img:not([src*="icon"]):not([src*="logo"])', name: 'images' },
      { sel: 'p', name: 'paragraphs' },
    ];

    console.log('\n  structural elements:');
    for (const { sel, name } of structureSearch) {
      const els = await page.$$(sel);
      if (els.length > 0) {
        for (let i = 0; i < Math.min(els.length, 3); i++) {
          const text = await els[i].evaluate(e => e.textContent?.trim().substring(0, 200));
          const cls = await els[i].evaluate(e => e.className?.toString().substring(0, 100));
          if (text) {
            console.log(`    ${name}[${i}] class="${cls}": "${text}"`);
          }
        }
      }
    }

    // look for reply / back navigation
    console.log('\n  navigation & actions:');
    const navSearch = [
      { sel: 'a:has-text("Reply")', name: 'Reply link' },
      { sel: 'button:has-text("Reply")', name: 'Reply button' },
      { sel: 'a:has-text("Back")', name: 'Back link' },
      { sel: 'a:has-text("Inbox")', name: 'Inbox link' },
      { sel: 'a[href*="inbox"]', name: 'inbox href' },
      { sel: 'a:has-text("Compose")', name: 'Compose link' },
      { sel: '[class*="reply"]', name: 'reply element' },
      { sel: '[class*="back"]', name: 'back element' },
    ];

    for (const { sel, name } of navSearch) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.evaluate(e => e.textContent?.trim().substring(0, 60));
        const href = await el.evaluate(e => e.href || '');
        console.log(`    ${name}: "${text}" href="${href}"`);
      }
    }

    await screenshot(page, 'readmsg-02-full-view');

    // scroll down to see full message
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await humanDelay(1000, 1500);
    await screenshot(page, 'readmsg-03-scrolled');

    // === NOW GO BACK AND READ SECOND MESSAGE TOO ===
    console.log('\n[5] going back to inbox...');
    const inboxLink = await page.$('a[href*="inbox"]:not([href*="view"])');
    if (inboxLink) {
      const href = await inboxLink.evaluate(e => e.href);
      console.log(`  clicking inbox link: ${href}`);
      await inboxLink.click();
      await humanDelay(2000, 3000);
      console.log(`  back at: ${page.url()}`);

      // read second message
      console.log('\n[6] opening second message...');
      const secondSubject = await page.$('table tr:nth-child(3) td:nth-child(2)');
      if (secondSubject) {
        const text = await secondSubject.evaluate(e => e.textContent?.trim());
        console.log(`  subject: "${text}"`);
        await secondSubject.click();
        await humanDelay(3000, 4000);
        console.log(`  URL: ${page.url()}`);
        await screenshot(page, 'readmsg-04-second-message');

        const msgText = await page.evaluate(() => document.body?.innerText);
        console.log(`\n  === SECOND MESSAGE TEXT ===\n${msgText?.substring(0, 2000)}\n  === END ===`);
      }
    }

    // keep open
    console.log('\n  browser staying open 30s...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'readmsg-error');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

verifyReadMsg();
