require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

async function verifyRead() {
  console.log('=== SECURUS MESSAGE READ VERIFICATION ===\n');

  const { browser, page } = await launchBrowser(false);

  try {
    // === LOGIN ===
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
    console.log('  logged in.');

    // === NAVIGATE TO INBOX ===
    console.log('\n[2] navigating to inbox...');
    await page.click('a[href*="inbox"]');
    await page.waitForURL('**/emessage/inbox**', { timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);
    console.log('  inbox loaded:', page.url());
    await screenshot(page, 'read-01-inbox');

    // === ANALYZE TABLE STRUCTURE ===
    console.log('\n[3] analyzing message table...');

    // get table rows (skip header)
    const rows = await page.$$('table tr');
    console.log(`  total table rows: ${rows.length}`);

    if (rows.length > 1) {
      // analyze first data row structure
      const firstRow = rows[1]; // skip header
      const cells = await firstRow.$$('td');
      console.log(`  cells in first data row: ${cells.length}`);

      for (let i = 0; i < cells.length; i++) {
        const text = await cells[i].evaluate(el => el.textContent?.trim().substring(0, 100));
        const html = await cells[i].evaluate(el => el.innerHTML?.substring(0, 200));
        console.log(`    cell[${i}]: text="${text}" html="${html}"`);
      }

      // check for clickable elements in the row
      const clickables = await firstRow.$$('a, [role="button"], [onclick]');
      console.log(`  clickable elements in first row: ${clickables.length}`);
      for (const el of clickables) {
        const tag = await el.evaluate(e => e.tagName);
        const text = await el.evaluate(e => e.textContent?.trim().substring(0, 60));
        const href = await el.evaluate(e => e.href || e.getAttribute('routerlink') || '');
        const cls = await el.evaluate(e => e.className?.substring(0, 80));
        console.log(`    ${tag}: "${text}" href="${href}" class="${cls}"`);
      }

      // check for icons/images in action column
      const lastCell = cells[cells.length - 1];
      const icons = await lastCell.$$('i, img, svg, span, a');
      console.log(`\n  action column elements: ${icons.length}`);
      for (const icon of icons) {
        const tag = await icon.evaluate(e => e.tagName);
        const cls = await icon.evaluate(e => e.className?.substring(0, 80));
        const title = await icon.evaluate(e => e.title || e.getAttribute('aria-label') || '');
        const href = await icon.evaluate(e => e.href || '');
        console.log(`    ${tag}: class="${cls}" title="${title}" href="${href}"`);
      }
    }

    // === TRY TO OPEN FIRST MESSAGE ===
    console.log('\n[4] attempting to open first message...');

    // strategy 1: click on the subject text/link in first data row
    const subjectLink = await page.$('table tr:nth-child(2) a');
    if (subjectLink) {
      const text = await subjectLink.evaluate(e => e.textContent?.trim().substring(0, 60));
      const href = await subjectLink.evaluate(e => e.href);
      console.log(`  found subject link: "${text}" → ${href}`);
    }

    // strategy 2: look for view/read action icon
    const viewIcons = await page.$$('table tr:nth-child(2) td:last-child a, table tr:nth-child(2) td:last-child i');
    console.log(`  action icons in first row: ${viewIcons.length}`);
    for (const icon of viewIcons) {
      const tag = await icon.evaluate(e => e.tagName);
      const href = await icon.evaluate(e => e.href || '');
      const cls = await icon.evaluate(e => e.className);
      const title = await icon.evaluate(e => e.title || e.getAttribute('aria-label') || '');
      console.log(`    ${tag}: href="${href}" class="${cls}" title="${title}"`);
    }

    // strategy 3: look for any row click handler or subject cell link
    // try clicking the subject cell (second column typically)
    let messageOpened = false;
    const preClickUrl = page.url();

    // try clicking the first link we find in the first data row
    const firstDataRowLinks = await page.$$('table tr:nth-child(2) a');
    if (firstDataRowLinks.length > 0) {
      const link = firstDataRowLinks[0];
      const href = await link.evaluate(e => e.href);
      console.log(`\n  clicking first link in row: ${href}`);
      await humanDelay(500, 1000);

      // check if it opens a new page
      const [newPage] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
        link.click(),
      ]);

      const msgPage = newPage || page;
      if (newPage) {
        console.log('  message opened in new tab');
        await newPage.waitForLoadState('networkidle', { timeout: 15000 });
      } else {
        await humanDelay(2000, 3000);
      }

      const postClickUrl = msgPage.url();
      if (postClickUrl !== preClickUrl || newPage) {
        messageOpened = true;
        console.log(`  navigated to: ${postClickUrl}`);
      }

      await screenshot(msgPage, 'read-02-message-opened');

      if (messageOpened) {
        // === ANALYZE MESSAGE VIEW ===
        console.log('\n[5] analyzing message view...');

        const pageText = await msgPage.evaluate(() => document.body?.innerText?.substring(0, 5000));
        console.log(`\n  message page text:\n  ---\n${pageText?.substring(0, 2000)}\n  ---`);

        // look for message-specific elements
        const msgElements = [
          { sel: '[class*="message-body"]', name: 'message body (class)' },
          { sel: '[class*="msg-body"]', name: 'msg body (class)' },
          { sel: '[class*="body"]', name: 'body element' },
          { sel: '[class*="content"]', name: 'content element' },
          { sel: '[class*="detail"]', name: 'detail element' },
          { sel: '[class*="subject"]', name: 'subject element' },
          { sel: '[class*="from"]', name: 'from element' },
          { sel: '[class*="sender"]', name: 'sender element' },
          { sel: '[class*="date"]', name: 'date element' },
          { sel: '[class*="reply"]', name: 'reply element' },
          { sel: 'textarea', name: 'textarea' },
          { sel: '[class*="compose"]', name: 'compose element' },
          { sel: 'p', name: 'paragraph' },
          { sel: 'pre', name: 'pre' },
        ];

        for (const { sel, name } of msgElements) {
          const els = await msgPage.$$(sel);
          if (els.length > 0) {
            const text = await els[0].evaluate(e => e.textContent?.trim().substring(0, 150));
            console.log(`  ${name} (${els.length}x): "${text}"`);
          }
        }

        // scan for back/inbox navigation
        const backLinks = [
          { sel: 'a:has-text("Back")', name: 'Back link' },
          { sel: 'a:has-text("Inbox")', name: 'Inbox link' },
          { sel: 'a[href*="inbox"]', name: 'inbox href link' },
          { sel: 'button:has-text("Back")', name: 'Back button' },
          { sel: '[class*="back"]', name: 'back element' },
        ];

        console.log('\n  navigation elements:');
        for (const { sel, name } of backLinks) {
          const el = await msgPage.$(sel);
          if (el) {
            const text = await el.evaluate(e => e.textContent?.trim().substring(0, 60));
            console.log(`    ${name}: ${sel} → "${text}"`);
          }
        }

        await screenshot(msgPage, 'read-03-message-detail');

        // try navigating back to inbox
        console.log('\n[6] navigating back to inbox...');
        const inboxLink = await msgPage.$('a[href*="inbox"]');
        if (inboxLink) {
          await inboxLink.click();
          await humanDelay(2000, 3000);
          console.log('  back at:', msgPage.url());
          await screenshot(msgPage, 'read-04-back-to-inbox');
        }
      }
    }

    if (!messageOpened) {
      console.log('\n  could not open message via link click');
      console.log('  trying direct row click...');
      const row = await page.$('table tr:nth-child(2)');
      if (row) {
        await row.click();
        await humanDelay(2000, 3000);
        console.log('  URL after row click:', page.url());
        await screenshot(page, 'read-02-row-click');
      }
    }

    // keep open
    console.log('\n  browser staying open 30s for inspection...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'read-error');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

verifyRead();
