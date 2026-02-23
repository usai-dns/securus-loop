require('dotenv').config();
const { launchBrowser, screenshot, humanDelay } = require('./utils/browser');

const LOGIN_URL = process.env.SECURUS_LOGIN_URL;
const EMAIL = process.env.SECURUS_LOGIN_EMAIL;
const PASSWORD = process.env.SECURUS_LOGIN_PASS;

async function verifyAuth() {
  console.log('=== SECURUS AUTH VERIFICATION ===\n');
  console.log(`target: ${LOGIN_URL}`);

  const { browser, page } = await launchBrowser(false); // headed — watch it work

  try {
    // step 1: navigate to login page
    console.log('\n[1] navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await humanDelay(1000, 2000);
    await screenshot(page, '01-login-page');

    // step 2: dump the page structure to understand the form
    console.log('\n[2] analyzing login form structure...');

    // look for input fields
    const inputs = await page.$$eval('input', els => els.map(el => ({
      type: el.type,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      className: el.className,
      ariaLabel: el.getAttribute('aria-label'),
    })));
    console.log('  input fields found:', JSON.stringify(inputs, null, 2));

    // look for buttons
    const buttons = await page.$$eval('button, input[type="submit"], a.btn, [role="button"]', els => els.map(el => ({
      tag: el.tagName,
      type: el.type,
      text: el.textContent?.trim().substring(0, 50),
      id: el.id,
      className: el.className,
    })));
    console.log('  buttons found:', JSON.stringify(buttons, null, 2));

    // step 3: try to fill email/username
    console.log('\n[3] filling email field...');

    // try multiple strategies to find the email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="userName"]',
      'input[id="email"]',
      'input[id="username"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="user" i]',
      'input[aria-label*="email" i]',
      'input[aria-label*="user" i]',
      'input:not([type="password"]):not([type="hidden"]):not([type="submit"])',
    ];

    let emailField = null;
    let emailSelector = null;
    for (const sel of emailSelectors) {
      const el = await page.$(sel);
      if (el) {
        emailField = el;
        emailSelector = sel;
        console.log(`  found email field with selector: ${sel}`);
        break;
      }
    }

    if (!emailField) {
      console.log('  ERROR: could not find email field');
      await screenshot(page, '01-error-no-email-field');
      // dump page HTML for analysis
      const html = await page.content();
      require('fs').writeFileSync('screenshots/login-page-html.txt', html);
      console.log('  dumped page HTML to screenshots/login-page-html.txt');
      return;
    }

    await emailField.click();
    await humanDelay(300, 600);
    await emailField.fill(EMAIL);
    await humanDelay(500, 1000);
    await screenshot(page, '02-email-filled');

    // step 4: fill password
    console.log('\n[4] filling password field...');

    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[id="password"]',
      'input[placeholder*="password" i]',
    ];

    let passwordField = null;
    let passwordSelector = null;
    for (const sel of passwordSelectors) {
      const el = await page.$(sel);
      if (el) {
        passwordField = el;
        passwordSelector = sel;
        console.log(`  found password field with selector: ${sel}`);
        break;
      }
    }

    if (!passwordField) {
      console.log('  ERROR: could not find password field');
      await screenshot(page, '02-error-no-password-field');
      return;
    }

    await passwordField.click();
    await humanDelay(300, 600);
    await passwordField.fill(PASSWORD);
    await humanDelay(500, 1000);
    await screenshot(page, '03-password-filled');

    // step 5: find and click submit
    console.log('\n[5] submitting login form...');

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Log In")',
      'button:has-text("Sign In")',
      'button:has-text("Submit")',
      'a:has-text("Login")',
      'a:has-text("Log In")',
      'a:has-text("Sign In")',
      '.login-btn',
      '#loginButton',
      '#login-button',
    ];

    let submitButton = null;
    let submitSelector = null;
    for (const sel of submitSelectors) {
      const el = await page.$(sel);
      if (el) {
        submitButton = el;
        submitSelector = sel;
        console.log(`  found submit button with selector: ${sel}`);
        break;
      }
    }

    if (!submitButton) {
      console.log('  ERROR: could not find submit button');
      await screenshot(page, '03-error-no-submit');
      // try Enter key as fallback
      console.log('  trying Enter key as fallback...');
      await page.keyboard.press('Enter');
    } else {
      await humanDelay(300, 600);
      await submitButton.click();
    }

    // step 6: wait for navigation / response
    console.log('\n[6] waiting for login response...');

    // wait for either navigation or error message
    try {
      await page.waitForNavigation({ timeout: 15000, waitUntil: 'networkidle' }).catch(() => {});
      // SPA might not trigger navigation — also wait for URL hash change or new content
      await humanDelay(3000, 5000);
    } catch (e) {
      console.log('  no traditional navigation detected (SPA expected)');
    }

    await screenshot(page, '04-post-login');

    // step 7: analyze post-login state
    console.log('\n[7] analyzing post-login state...');

    const currentUrl = page.url();
    console.log(`  current URL: ${currentUrl}`);

    const pageTitle = await page.title();
    console.log(`  page title: ${pageTitle}`);

    // check for error messages
    const errorSelectors = [
      '.error', '.alert-danger', '.login-error', '[class*="error"]',
      '.alert', '.warning', '.notification',
      '[role="alert"]',
    ];

    for (const sel of errorSelectors) {
      const errors = await page.$$eval(sel, els => els.map(el => el.textContent?.trim()).filter(Boolean));
      if (errors.length > 0) {
        console.log(`  error/alert found (${sel}):`, errors);
      }
    }

    // check for 2FA / CAPTCHA indicators
    const twoFaIndicators = [
      'input[name="code"]', 'input[name="otp"]', 'input[name="verificationCode"]',
      'input[placeholder*="code" i]', 'input[placeholder*="verification" i]',
      '[class*="captcha" i]', '[id*="captcha" i]', 'iframe[src*="recaptcha"]',
      'iframe[src*="captcha"]',
    ];

    for (const sel of twoFaIndicators) {
      const el = await page.$(sel);
      if (el) {
        console.log(`  2FA/CAPTCHA detected: ${sel}`);
        await screenshot(page, '04-2fa-or-captcha');
      }
    }

    // check if we're on a new page (login success indicators)
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 2000));
    console.log(`\n  page content preview:\n  ---\n  ${bodyText?.substring(0, 500)}\n  ---`);

    // look for common post-login elements
    const postLoginIndicators = [
      { sel: 'a[href*="inbox"]', name: 'inbox link' },
      { sel: 'a[href*="message"]', name: 'message link' },
      { sel: '[class*="inbox"]', name: 'inbox element' },
      { sel: '[class*="dashboard"]', name: 'dashboard element' },
      { sel: '[class*="welcome"]', name: 'welcome element' },
      { sel: '[class*="account"]', name: 'account element' },
      { sel: 'a[href*="logout"]', name: 'logout link' },
      { sel: 'button:has-text("Logout")', name: 'logout button' },
      { sel: 'button:has-text("Log Out")', name: 'logout button' },
      { sel: 'nav', name: 'navigation bar' },
    ];

    console.log('\n  post-login element scan:');
    for (const { sel, name } of postLoginIndicators) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.evaluate(e => e.textContent?.trim().substring(0, 80));
        console.log(`    found ${name}: ${sel} → "${text}"`);
      }
    }

    // final screenshot
    await screenshot(page, '05-final-state');

    // === SUMMARY ===
    console.log('\n=== SELECTOR SUMMARY ===');
    console.log(`email field:    ${emailSelector}`);
    console.log(`password field: ${passwordSelector}`);
    console.log(`submit button:  ${submitSelector}`);
    console.log(`post-login URL: ${currentUrl}`);
    console.log('========================\n');

    // keep browser open for manual inspection
    console.log('browser staying open for 30 seconds for manual inspection...');
    console.log('(check the browser window now)');
    await new Promise(resolve => setTimeout(resolve, 30000));

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    await screenshot(page, 'error-fatal');
  } finally {
    await browser.close();
    console.log('\nbrowser closed. done.');
  }
}

verifyAuth();
