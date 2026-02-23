const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, '..', '..', 'screenshots');

// ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function launchBrowser(headless = false) {
  const browser = await chromium.launch({
    headless,
    slowMo: 100, // human-like delay between actions
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function screenshot(page, name) {
  const filename = `${Date.now()}-${name}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`  screenshot: ${filename}`);
  return filepath;
}

async function humanDelay(min = 500, max = 2000) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  await new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { launchBrowser, screenshot, humanDelay, SCREENSHOTS_DIR };
