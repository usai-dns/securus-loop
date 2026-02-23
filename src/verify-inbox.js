require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

async function verifyInbox() {
  console.log('=== SECURUS INBOX VERIFICATION ===\n');

  const { browser, page } = await launchBrowser(false);

  try {
    // === LOGIN (verified flow) ===
    console.log('[1] logging in...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(1000, 2000);

    await page.fill('input[type="email"]', EMAIL);
    await humanDelay(300, 600);
    await page.fill('input[type="password"]', PASSWORD);
    await humanDelay(300, 600);
    await page.click('button[type="submit"]');

    // wait for post-login page
    await page.waitForURL('**/my-account**', { timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);
    console.log('  logged in. URL:', page.url());
    await screenshot(page, 'inbox-01-logged-in');

    // === FIND eMESSAGING SECTION ===
    console.log('\n[2] looking for eMessaging section...');

    // scan all links on the page
    const links = await page.$$eval('a', els => els.map(el => ({
      text: el.textContent?.trim().substring(0, 60),
      href: el.href,
      className: el.className,
    })));
    console.log('  all links:');
    links.forEach(l => {
      if (l.text) console.log(`    "${l.text}" → ${l.href}`);
    });

    // look for the LAUNCH link near eMessaging
    const launchSelectors = [
      'a[href*="inbox"]',
      'a[href*="emessaging"]',
      'a[href*="messaging"]',
      'a:has-text("LAUNCH")',
      'a:has-text("Launch")',
    ];

    let launchLink = null;
    let launchSelector = null;
    for (const sel of launchSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.evaluate(e => e.textContent?.trim());
        const href = await el.evaluate(e => e.href);
        console.log(`  found: ${sel} → "${text}" (${href})`);
        launchLink = el;
        launchSelector = sel;
        break;
      }
    }

    if (!launchLink) {
      console.log('  ERROR: could not find launch/inbox link');
      await screenshot(page, 'inbox-02-error-no-launch');
      return;
    }

    // === CLICK INTO eMESSAGING ===
    console.log('\n[3] clicking into eMessaging...');
    await humanDelay(500, 1000);

    // check if link opens new tab/window
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
      launchLink.click(),
    ]);

    let inboxPage = newPage || page;

    if (newPage) {
      console.log('  eMessaging opened in new tab');
      await newPage.waitForLoadState('networkidle', { timeout: 15000 });
    } else {
      console.log('  eMessaging loaded in same tab');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    await humanDelay(2000, 3000);
    console.log('  inbox URL:', inboxPage.url());
    await screenshot(inboxPage, 'inbox-02-emessaging-loaded');

    // === ANALYZE INBOX PAGE ===
    console.log('\n[4] analyzing inbox page structure...');

    const inboxUrl = inboxPage.url();
    const inboxTitle = await inboxPage.title();
    console.log(`  URL: ${inboxUrl}`);
    console.log(`  title: ${inboxTitle}`);

    // dump all inputs
    const inputs = await inboxPage.$$eval('input, textarea', els => els.map(el => ({
      tag: el.tagName,
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      className: el.className?.substring(0, 80),
    })));
    console.log('\n  inputs/textareas:', JSON.stringify(inputs, null, 2));

    // dump all buttons
    const buttons = await inboxPage.$$eval('button, input[type="submit"], [role="button"]', els => els.map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim().substring(0, 60),
      id: el.id,
      className: el.className?.substring(0, 80),
    })));
    console.log('\n  buttons:', JSON.stringify(buttons, null, 2));

    // look for message-related elements
    const messageIndicators = [
      { sel: '[class*="message"]', name: 'message element' },
      { sel: '[class*="inbox"]', name: 'inbox element' },
      { sel: '[class*="thread"]', name: 'thread element' },
      { sel: '[class*="conversation"]', name: 'conversation element' },
      { sel: '[class*="contact"]', name: 'contact element' },
      { sel: '[class*="compose"]', name: 'compose element' },
      { sel: '[class*="stamp"]', name: 'stamp element' },
      { sel: 'table', name: 'table' },
      { sel: 'tr', name: 'table row' },
      { sel: 'li', name: 'list item' },
      { sel: '[class*="list"]', name: 'list element' },
      { sel: '[class*="unread"]', name: 'unread indicator' },
      { sel: '[class*="sender"]', name: 'sender element' },
      { sel: '[class*="subject"]', name: 'subject element' },
      { sel: '[class*="date"]', name: 'date element' },
      { sel: '[class*="time"]', name: 'time element' },
      { sel: 'iframe', name: 'iframe' },
    ];

    console.log('\n  scanning for message-related elements:');
    for (const { sel, name } of messageIndicators) {
      const els = await inboxPage.$$(sel);
      if (els.length > 0) {
        const firstText = await els[0].evaluate(e => e.textContent?.trim().substring(0, 100));
        console.log(`    ${name} (${els.length}x): ${sel} → "${firstText}"`);
      }
    }

    // check for iframes (messaging might be in iframe)
    const iframes = await inboxPage.$$('iframe');
    if (iframes.length > 0) {
      console.log(`\n  found ${iframes.length} iframe(s):`);
      for (let i = 0; i < iframes.length; i++) {
        const src = await iframes[i].evaluate(f => f.src);
        const name = await iframes[i].evaluate(f => f.name || f.id);
        console.log(`    iframe[${i}]: src="${src}" name/id="${name}"`);

        // try to access iframe content
        try {
          const frame = iframes[i].contentFrame ? await iframes[i].contentFrame() : null;
          if (frame) {
            const frameContent = await frame.evaluate(() => document.body?.innerText?.substring(0, 500));
            console.log(`    iframe content preview: "${frameContent}"`);
            await screenshot(inboxPage, `inbox-03-iframe-${i}`);
          }
        } catch (e) {
          console.log(`    could not access iframe content: ${e.message}`);
        }
      }
    }

    // get full page text content
    const pageText = await inboxPage.evaluate(() => document.body?.innerText?.substring(0, 3000));
    console.log(`\n  full page text preview:\n  ---\n${pageText?.substring(0, 1000)}\n  ---`);

    await screenshot(inboxPage, 'inbox-04-final');

    // keep open for inspection
    console.log('\n  browser staying open 30s for inspection...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'inbox-error');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

verifyInbox();
