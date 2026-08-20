# securus-loop

## mandatory reads

- **ARCHITECTURE.md** — read before planning or making changes. Contains full system design, message lifecycle, database schema, invariants, and file structure.

## tests

- **Run tests before pushing**: `npm test` (runs `tests/unit.test.mjs`)
- Tests cover: series detection, doc command parsing, message splitting, escalation detection
- Tests MUST pass on all code changes unless the change intentionally modifies tested behavior
- When adding new pure functions, add corresponding tests

## deployment

### how to deploy

```bash
npx wrangler deploy
```

Then hit `/migrate` to run any new DB migrations.

### cloudflare environment

- **Worker**: `securus-agent` at `https://securus-agent.usai-dlh.workers.dev`
- **Account**: `Usai.dlh@gmail.com's Account` (ID: `f1d19cc490b902a854ac1b43b5808673`)
- **D1 Database**: `securus-agent-db` (ID: `f597be17-021b-4b35-89bf-cb39cac70251`)
- **Browser Rendering**: bound as `env.BROWSER` — headless Chromium for Puppeteer
- **Cron**: `0 * * * *` (every hour on the hour, with random 0-30s jitter)

### claude code cloud permissions

The Claude Code cloud environment has a `CLOUDFLARE_API_TOKEN` environment variable pre-configured with access to the Cloudflare account above. This token can:

- **Deploy workers** via `npx wrangler deploy`
- **Read/write D1 databases** (query, migrate, inspect)
- **Manage worker secrets** via `npx wrangler secret put`
- **View logs** via `npx wrangler tail`

The token does NOT have User Details read permission (the `whoami` email is hidden). Secrets (SECURUS_LOGIN_EMAIL, SECURUS_LOGIN_PASS, ANTHROPIC_API_KEY, Twilio creds) are stored as Cloudflare Worker secrets — not in wrangler.toml or code.

### worker bindings

| Binding | Type | Value |
|---|---|---|
| `env.DB` | D1 Database | securus-agent-db |
| `env.BROWSER` | Browser Rendering | headless Chromium |
| `env.SECURUS_LOGIN_URL` | var | `https://securustech.online/#/login` |
| `env.SAM_CONTACT_ID` | var | `65651103` |
| `env.SITE_ID` | var | `09420` |
| `env.SECURUS_LOGIN_EMAIL` | secret | (stored in CF) |
| `env.SECURUS_LOGIN_PASS` | secret | (stored in CF) |
| `env.ANTHROPIC_API_KEY` | secret | (stored in CF) |
| `env.TWILIO_*` | secret | (stored in CF) |
| `env.DENNIS_PHONE` | secret | (stored in CF) |

## foxvox build (payment portal / service productization)

**Read `docs/HANDOFF.md` first when continuing this work** — full state of the
FoxVox build (Stripe live: $29/mo product; Telnyx 10DLC complete; portal worker
`foxvox-portal` + `foxvox-billing-db`; staging branch `staging/contact-crawler`
for signup/add-contact recon; build plan step 2 onward). The SMS relay wires
through the `call-operations` worker (Telnyx creds + POST /sms) — its source is
in Dennis's local repos.

**A2P 10DLC / SMS compliance:** the opt-in is on the real signup page (`portal/src/pages.mjs`,
consent copy in `portal/src/consent.mjs` — byte-identical to `../foxvox-a2p/src/copy.mjs`). Registration
tooling, pre-check and runbook live in the sibling repo `usai-dns/foxvox-a2p`. Never change consent copy in
one place only; never add 2FA/verification-code wording (undeclared use case → carrier rejection).

**Website + payments:** `foxvox-portal` serves all of foxvox.ai (site, /signup → Stripe Checkout,
/welcome, /account, webhook). See `docs/HANDOFF.md` "Website + payment portal".

## what this is

Autonomous messaging agent for Securus. Logs in, reads messages, generates replies as Dennis using Claude API, sends them back. Runs on Cloudflare Workers with Browser Rendering + D1.

Sam knows this system exists. The AI speaks as Dennis (first person).

## current status

**v5-dashboard** — three-phase cron (SCAN → GENERATE → SEND) with persistent send_queue and inbound_series tables, plus a monitoring dashboard.

- Outbound multi-part messages tracked in `send_queue` (crash-safe, resumable, auto-retry with backoff)
- Inbound multi-part messages tracked in `inbound_series` (pattern: "message N/M")
- Dedup guards prevent re-generation and re-sending; content-duplicate guard catches Sam's re-sends
- Governing documents: one living body per topic (`documents` table), AI-edited in place on makenew/makeupdate — the combined manuscript, distinct from the message stream
- Monitoring dashboard at `/dashboard?token=…` (state + governing documents with Document/History tabs + activity)
- All messages preserved in D1 `messages` table
- Open issues tracked in `docs/ISSUES.md`; GitHub issue script in `scripts/file-github-issues.sh`
- **NOTE: Twilio secrets are NOT configured — all SMS notifications (incl. escalation) are currently no-ops (issue #10)**

## critical discoveries

1. **stamp confirmation modal**: clicking Send opens a `.reveal-overlay` modal. MUST click `button:has-text("Confirm")` to actually send.
2. **no reply button**: message view has no reply — must navigate to Compose page separately
3. **open messages by clicking row**: click `td:nth-child(2)` (subject cell), NOT action column (that's delete)
4. **angular SPA**: hash routing (`#/...`), use `waitUntil: 'networkidle'` for page loads
5. **character limit**: 20,000 chars shared between subject + body
6. **message IDs**: in URL as `?messageId={ID}&siteId=09420` — use as dedup key in D1
7. **series pattern**: only "message N/M" triggers series collection — bare N/M does not
8. **T&C modal blocks login**: Securus presents amended Terms & Conditions in a `.reveal-overlay` at sign-in (seen June 2026, v3.1). Login submits but no redirect until "Accept" is clicked. Handled by `acceptPendingTerms` in auth.mjs (also called in compose flow). Diagnose with `/login-debug`.
9. **INSUFFICIENT STAMPS modal**: when stamps run out, clicking Send opens a modal with "CANCEL / PURCHASE STAMPS" instead of Confirm — looks identical to a missing-Confirm failure. compose.mjs detects it and returns `insufficientStamps: true`; phaseSend leaves parts `pending` (auto-resume next cron after stamps purchased) and SMSes Dennis once per 24h. Stamp purchasing is being AUTOMATED (direction change 2026-08-18): recon of the purchase flow runs in phaseScan (`stamp_purchase_recon` state); the autobuy engine (`src/securus/stamps.mjs`, `/stamp-autobuy` endpoint) is guarded — disabled by default, low-water trigger, daily/weekly caps, every attempt logged + SMSed. The purchase click-path stays inert until recon-verified selectors are reviewed; never best-guess selectors in a purchase flow.

## verified selectors (quick reference)

```
login:     input[type="email"], input[type="password"], button[type="submit"]
inbox:     a[href*="inbox"] from my-account, messages in <table>, td:nth-child(2) to open
read:      .message for body, p.font-bold for sender, messageId in URL params
compose:   select#select-inmate (sam=65651103), input[name="subject"], textarea#message
send:      button[type="submit"]:has-text("Send") → then button:has-text("Confirm") in modal
```

Full selector details in `src/securus/selectors.mjs`.

## contacts

- **SAMUEL MULLIKIN**: ID `65651103`, Colorado State Prison System, site `09420`
- **RICARDO CHALCHISEVILLA**: ID `67887839`, DOC `156419`, Spanish replies
- **DENISE PRESSON**: DOC `100721` — STAGED (not yet an approved Securus contact; auto-activates + sends welcome when she appears in the compose dropdown)

## user preferences

- never delete messages
- no co-author tags in git commits
- sam knows it's AI-augmented — fully autonomous, no approval step needed
- escalation rules: emergency/urgent messages trigger SMS to dennis instead of auto-reply
