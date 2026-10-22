// Per-tenant access-pattern scheduler. Goal: each customer's Securus account is
// visited on its OWN irregular rhythm — never on the hour, never in lockstep with
// other tenants, weighted toward the hours a real family member would check —
// so our logins don't form a detectable pattern on Securus's side.
//
// A tenant row carries `schedule` (JSON, DEFAULT_SCHEDULE if null) and
// `next_run_at` (ISO). A frequent cron (e.g. */10) runs only tenants whose
// next_run_at <= now, then draws the next slot with computeNextRun().
export const DEFAULT_SCHEDULE = {
  tz: 'America/Denver',
  minGapMin: 45,          // never sooner than this after a visit
  maxGapMin: 150,         // never later than this during active hours
  activeHours: [7, 23],   // local hours in which visits normally happen
  nightGapMin: [240, 480],// overnight: one visit every 4–8 h at most
  skipChance: 0.08,       // occasionally skip a slot entirely (humans do)
  secondsJitter: 59 * 60, // spread across the hour; never aligned to :00
};

function localHour(ms, tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date(ms))) % 24; }
  catch { return new Date(ms).getUTCHours(); }
}
// Deterministic-enough RNG hook for tests.
export function computeNextRun(nowMs, sched = DEFAULT_SCHEDULE, rnd = Math.random) {
  const s = { ...DEFAULT_SCHEDULE, ...(sched || {}) };
  const hour = localHour(nowMs, s.tz);
  const active = hour >= s.activeHours[0] && hour < s.activeHours[1];
  let gapMin;
  if (active) {
    // log-ish distribution: most visits 45–90 min apart, a tail to maxGap
    const u = rnd();
    gapMin = s.minGapMin + Math.pow(u, 1.6) * (s.maxGapMin - s.minGapMin);
    if (rnd() < s.skipChance) gapMin += s.minGapMin + rnd() * s.minGapMin; // skip one slot
  } else {
    gapMin = s.nightGapMin[0] + rnd() * (s.nightGapMin[1] - s.nightGapMin[0]);
  }
  let next = nowMs + gapMin * 60_000 + Math.floor(rnd() * 60_000); // sub-minute jitter
  // avoid landing within ±3 min of a top-of-hour (bot fingerprint)
  const m = new Date(next).getUTCMinutes();
  if (m <= 3 || m >= 57) next += (4 + Math.floor(rnd() * 10)) * 60_000;
  return new Date(next).toISOString();
}
// Human-like dwell between page actions inside a visit (ms).
export function dwellMs(rnd = Math.random) { return 900 + Math.floor(Math.pow(rnd(), 2) * 6000); }
