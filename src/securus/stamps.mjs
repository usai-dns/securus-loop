// Automated stamp purchasing.
//
// DIRECTION CHANGE (2026-08-18): stamp purchases are now to be automated (they
// were previously manual-only by rule). Because this is browser automation
// moving real money, it ships in two stages:
//   1. RECON (live now, in phaseScan): read-only capture of the purchase flow
//      into state key `stamp_purchase_recon` — never clicks purchase/confirm.
//   2. PURCHASE (this module): enabled ONLY after recon-verified selectors are
//      filled in AND the config flag is turned on. Until then purchaseStamps()
//      returns notImplemented and the guard keeps everything inert.
//
// Safeguards (non-negotiable):
//   - disabled by default; explicit config flip required (`stamp_autobuy` state)
//   - fires only when balance < lowWater
//   - hard caps: max purchases per 24h and per 7d
//   - every attempt (success OR failure) is appended to `stamp_purchase_log`
//     and SMSed to Dennis — a purchase must never be silent
//   - any ambiguity in the flow (unexpected modal, price mismatch, missing
//     saved payment method) → abort without clicking, log, notify

import { getState, setState } from '../db/state.mjs';

export const AUTOBUY_DEFAULTS = {
  enabled: false,     // master switch — flip via /stamp-autobuy config endpoint
  lowWater: 10,       // buy when balance drops below this
  packPreference: 'smallest', // which package to buy when multiple offered
  maxPerDay: 1,
  maxPerWeek: 3,
};

export async function getAutobuyConfig(db) {
  try {
    const raw = await getState(db, 'stamp_autobuy');
    return { ...AUTOBUY_DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...AUTOBUY_DEFAULTS };
  }
}

export async function getPurchaseLog(db) {
  try {
    const raw = await getState(db, 'stamp_purchase_log');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function recordPurchaseAttempt(db, entry) {
  const log = await getPurchaseLog(db);
  log.unshift({ ts: new Date().toISOString(), ...entry });
  await setState(db, 'stamp_purchase_log', JSON.stringify(log.slice(0, 50)));
}

// Decide whether an auto-purchase may proceed right now. Returns
// { allowed, reason } — reason explains any refusal for the log.
export async function autobuyGuard(db, config, balance) {
  if (!config.enabled) return { allowed: false, reason: 'autobuy disabled' };
  if (balance === null || balance === undefined) return { allowed: false, reason: 'balance unknown — refusing to buy blind' };
  if (balance >= config.lowWater) return { allowed: false, reason: `balance ${balance} >= lowWater ${config.lowWater}` };

  const log = await getPurchaseLog(db);
  const now = Date.now();
  const attempted = (hours) => log.filter(e => e.attempted && now - new Date(e.ts).getTime() < hours * 3.6e6).length;
  if (attempted(24) >= config.maxPerDay) return { allowed: false, reason: `daily cap reached (${config.maxPerDay})` };
  if (attempted(24 * 7) >= config.maxPerWeek) return { allowed: false, reason: `weekly cap reached (${config.maxPerWeek})` };

  return { allowed: true, reason: `balance ${balance} < ${config.lowWater}, caps clear` };
}

// Execute a stamp purchase on an already-logged-in page.
// NOT YET IMPLEMENTED: the click-path requires selectors verified from the
// recon capture (`stamp_purchase_recon`). Until those are reviewed and filled
// in, this returns notImplemented and clicks NOTHING. Do not "best-guess"
// selectors here — a wrong click in a purchase flow spends real money.
export async function purchaseStamps(page, config) {
  return {
    success: false,
    notImplemented: true,
    note: 'purchase click-path pending recon-verified selectors (state: stamp_purchase_recon)',
  };
}
