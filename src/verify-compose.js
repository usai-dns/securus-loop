require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

async function verifyCompose() {
  console.log('=== SECURUS COMPOSE VERIFICATION ===\n');

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
    console.log('  inbox loaded:', page.url());

    // === NAVIGATE TO COMPOSE ===
    console.log('\n[3] clicking Compose...');

    // find compose link in sidebar
    const composeLink = await page.$('a:has-text("Compose")');
    if (!composeLink) {
      // try other selectors
      const links = await page.$$eval('a', els => els.map(e => ({
        text: e.textContent?.trim(),
        href: e.href,
      })).filter(l => l.text?.toLowerCase().includes('compose')));
      console.log('  compose links found:', links);

      if (links.length === 0) {
        console.log('  ERROR: no compose link found');
        await screenshot(page, 'compose-error-no-link');
        return;
      }
    }

    await humanDelay(500, 1000);
    await composeLink.click();
    await humanDelay(2000, 3000);
    console.log('  compose URL:', page.url());
    await screenshot(page, 'compose-01-compose-page');

    // === ANALYZE COMPOSE PAGE ===
    console.log('\n[4] analyzing compose page...');

    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000));
    console.log(`\n  page text:\n  ---\n${pageText?.substring(0, 1500)}\n  ---`);

    // find all form elements
    const formElements = await page.$$eval('input, textarea, select, [contenteditable]', els => els.map(el => ({
      tag: el.tagName,
      type: el.type || '',
      name: el.name,
      id: el.id,
      placeholder: el.placeholder || '',
      className: el.className?.substring(0, 80),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      value: el.value?.substring(0, 50),
    })));
    console.log('\n  form elements:', JSON.stringify(formElements, null, 2));

    // find all buttons
    const buttons = await page.$$eval('button, input[type="submit"], [role="button"]', els => els.map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim().substring(0, 60),
      id: el.id,
      className: el.className?.substring(0, 80),
      type: el.type,
      disabled: el.disabled,
    })));
    console.log('\n  buttons:', JSON.stringify(buttons, null, 2));

    // find dropdowns / selects for recipient
    const selects = await page.$$('select');
    console.log(`\n  select elements: ${selects.length}`);
    for (const sel of selects) {
      const options = await sel.$$eval('option', opts => opts.map(o => ({
        value: o.value,
        text: o.textContent?.trim(),
        selected: o.selected,
      })));
      console.log('    options:', JSON.stringify(options));
    }

    // look for contact/recipient selection
    const recipientSearch = [
      { sel: '[class*="contact"]', name: 'contact element' },
      { sel: '[class*="recipient"]', name: 'recipient element' },
      { sel: '[class*="to"]', name: 'to element' },
      { sel: 'select', name: 'select dropdown' },
      { sel: '[class*="dropdown"]', name: 'dropdown' },
      { sel: '[class*="select"]', name: 'select element' },
      { sel: '[class*="stamp"]', name: 'stamp element' },
      { sel: '[class*="char"]', name: 'character element' },
      { sel: '[class*="count"]', name: 'count element' },
      { sel: '[class*="limit"]', name: 'limit element' },
    ];

    console.log('\n  compose-specific elements:');
    for (const { sel, name } of recipientSearch) {
      const els = await page.$$(sel);
      if (els.length > 0) {
        for (let i = 0; i < Math.min(els.length, 3); i++) {
          const text = await els[i].evaluate(e => e.textContent?.trim().substring(0, 120));
          const cls = await els[i].evaluate(e => e.className?.toString().substring(0, 100));
          if (text) {
            console.log(`    ${name}[${i}] class="${cls}": "${text}"`);
          }
        }
      }
    }

    await screenshot(page, 'compose-02-analyzed');

    // === TRY SELECTING A RECIPIENT ===
    console.log('\n[5] attempting to select recipient...');

    // check if there's a contact list / dropdown to select Samuel
    const contactOptions = await page.$$('select option, [class*="contact"] li, [class*="contact"] a, [class*="contact"] div');
    console.log(`  potential contact options: ${contactOptions.length}`);
    for (const opt of contactOptions.slice(0, 10)) {
      const text = await opt.evaluate(e => e.textContent?.trim().substring(0, 60));
      const tag = await opt.evaluate(e => e.tagName);
      if (text) console.log(`    ${tag}: "${text}"`);
    }

    // if there's a select dropdown, try selecting Samuel
    if (selects.length > 0) {
      const samuelOption = await page.$('select option:has-text("SAMUEL")');
      if (samuelOption) {
        const value = await samuelOption.evaluate(e => e.value);
        console.log(`  found Samuel option, value: ${value}`);
        await selects[0].selectOption(value);
        await humanDelay(1000, 2000);
        await screenshot(page, 'compose-03-recipient-selected');
      }
    }

    // === FIND MESSAGE TEXTAREA ===
    console.log('\n[6] looking for message textarea...');
    const textarea = await page.$('textarea');
    if (textarea) {
      const maxLength = await textarea.evaluate(e => e.maxLength);
      const placeholder = await textarea.evaluate(e => e.placeholder);
      const cls = await textarea.evaluate(e => e.className);
      console.log(`  textarea found: maxLength=${maxLength} placeholder="${placeholder}" class="${cls}"`);

      // type a test message (DO NOT SEND)
      await textarea.click();
      await humanDelay(300, 600);
      await textarea.fill('TEST MESSAGE - DO NOT SEND - verifying compose flow');
      await humanDelay(500, 1000);
      await screenshot(page, 'compose-04-message-typed');

      // check if character counter updated
      const counterEls = await page.$$('[class*="char"], [class*="count"], [class*="remaining"]');
      for (const el of counterEls) {
        const text = await el.evaluate(e => e.textContent?.trim());
        console.log(`  counter/limit: "${text}"`);
      }
    } else {
      console.log('  no textarea found');
      // check for contenteditable div
      const editable = await page.$('[contenteditable="true"]');
      if (editable) {
        console.log('  found contenteditable div');
      }
    }

    // === FIND SEND BUTTON (but DO NOT click it) ===
    console.log('\n[7] looking for send button (will NOT click)...');
    const sendSearch = [
      'button:has-text("Send")',
      'input[type="submit"]:has-text("Send")',
      'button:has-text("Submit")',
      'a:has-text("Send")',
      '[class*="send"]',
      'button[type="submit"]',
    ];

    for (const sel of sendSearch) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.evaluate(e => e.textContent?.trim().substring(0, 60));
        const cls = await el.evaluate(e => e.className);
        const disabled = await el.evaluate(e => e.disabled);
        console.log(`  send candidate (${sel}): text="${text}" class="${cls}" disabled=${disabled}`);
      }
    }

    // check for subject field
    console.log('\n[8] checking for subject field...');
    const subjectField = await page.$('input[name="subject"], input[placeholder*="subject" i], input[type="text"]');
    if (subjectField) {
      const maxLen = await subjectField.evaluate(e => e.maxLength);
      const placeholder = await subjectField.evaluate(e => e.placeholder);
      console.log(`  subject field: maxLength=${maxLen} placeholder="${placeholder}"`);
    } else {
      console.log('  no subject field found');
    }

    await screenshot(page, 'compose-05-final');

    // === SUMMARY ===
    console.log('\n=== COMPOSE FLOW SUMMARY ===');
    console.log('DO NOT SEND - this was observation only');
    console.log('============================\n');

    // keep open
    console.log('  browser staying open 30s...');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'compose-error');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

verifyCompose();
