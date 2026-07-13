import { chromium } from 'playwright';
import fs from 'fs';
import { renderDashboardHTML } from '../src/dashboard.mjs';
const apiJson = fs.readFileSync('/tmp/dash.json','utf8');
const html = renderDashboardHTML('');
for (const scheme of ['light','dark']) {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(async () => await chromium.launch());
  const ctx = await b.newContext({ colorScheme: scheme, viewport: { width: 1200, height: 1600 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('https://dash.local/api/dashboard*', route => route.fulfill({ status:200, contentType:'application/json', body: apiJson }));
  await p.route('https://dash.local/dashboard', route => route.fulfill({ status:200, contentType:'text/html', body: html }));
  await p.goto('https://dash.local/dashboard', { waitUntil:'domcontentloaded', timeout:15000 });
  await p.waitForSelector('.docitem', { timeout: 8000 }).catch(()=>{});
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `/tmp/dash-${scheme}.png`, fullPage: true });
  const health = await p.textContent('#healthTxt').catch(()=>'?');
  const tiles = await p.$$eval('.tile .v', els => els.map(e=>e.textContent));
  const docs = await p.$$eval('.docitem .nm', els => els.map(e=>e.textContent));
  const tlItems = await p.$$eval('.tl', els => els.length);
  const sparkDots = await p.$$eval('#spark circle', els => els.length);
  const tlTitle = await p.textContent('#tlTitle').catch(()=>'?');
  console.log(`[${scheme}] health=${health} tiles=${JSON.stringify(tiles)} docs=${JSON.stringify(docs)} panel="${tlTitle}" timeline=${tlItems} sparkDots=${sparkDots} errors=${errs.length}`);
  if (errs.length) console.log('  errors:', errs.slice(0,3));
  await b.close();
}
