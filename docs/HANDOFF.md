# Handoff — continue development locally

Written 2026-08-20 from the remote session. Everything below is pushed; this
doc is the state of record for continuing on a local machine (where the
Telnyx/call-operations source repos are available).

## Why local

The SMS relay wires through the existing **`call-operations`** worker (it holds
`TELNYX_API_TOKEN`, `TELNYX_CONNECTION_ID`, `TELNYX_MESSAGING_PROFILE_ID`, a
`POST /sms` endpoint, an SMS durable object, and a `telnyx.ts` module).
Its source lives in Dennis's local repos — a local session can read it and
either (a) add a **service binding** from `foxvox-portal` → `call-operations`
and call its `/sms` route, or (b) lift the `telnyx.ts` send helper. 10DLC
registration was believed complete ("telnyx connected", 2026-08-20) — **it is not**; see the
"A2P 10DLC + signup page" section below.

## Getting started locally

```bash
git clone git@github.com:usai-dns/securus-loop.git && cd securus-loop
git checkout claude/deploy-test-worker-TeBfE   # the main development line
npm install
npm test                                        # 99 tests, all green
# auth: `npx wrangler login` as Usai.dlh@gmail.com — or CLOUDFLARE_API_TOKEN env
# account: "Usai.dlh@gmail.com's Account"  f1d19cc490b902a854ac1b43b5808673
claude                                          # CLAUDE.md carries project context
```

Admin tokens (DASH_TOKEN on securus-agent, ADMIN_TOKEN on foxvox-portal) are
write-only Cloudflare secrets; the remote session's plaintext copies do not
transfer. **Rotate to regain admin access:**

```bash
head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 28 | npx wrangler secret put DASH_TOKEN --name securus-agent
head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 28 | npx wrangler secret put ADMIN_TOKEN --name foxvox-portal
# (print/save the values you generate — dashboard URL is /dashboard?token=…)
```

## Branches

| Branch | Contents |
|---|---|
| `claude/deploy-test-worker-TeBfE` | Main line — everything deployed to production. `main` is far behind; merge when ready. |
| `staging/contact-crawler` | Read-only recon crawlers: Securus **add-contact** flow + **signup** ("Create an Account") flow, plus `/add-contact-recon`, `/signup-recon` endpoints. Not deployed. Click-paths intentionally `notImplemented` until recon captures are reviewed — never guess in flows that create facility-side records. |

## Deployed infrastructure

| Thing | Value |
|---|---|
| `securus-agent` worker | messaging loop; latest deploy = enumeration-retry fix |
| `foxvox-portal` worker | billing skeleton; latest deploy = descriptor note |
| `securus-agent-db` (D1) | `f597be17-021b-4b35-89bf-cb39cac70251` — message content; bound ONLY to securus-agent |
| `foxvox-billing-db` (D1) | `a4aac043-9c42-4287-aa42-86080e9c83d3` — payers/sponsorships/invite_codes/ledger/config; bound to foxvox-portal |
| `foxvox.ai` zone | active on this Cloudflare account (portal domain + email sending) |
| Cron | securus-agent hourly `0 * * * *` (scan → generate → send; 15-min budget — manual `/scan` gets cut by HTTP waitUntil limits, prefer cron) |

## Stripe (live, complete)

- Restricted key on `foxvox-portal` as `STRIPE_SECRET_KEY` (server-side
  whitespace-stripped — dashboard pastes can embed newlines mid-key).
  Write perms: Products, Prices, Checkout Sessions, Customers, Subscriptions,
  Payment Intents.
- Account `acct_1SzqFeF0MsCnMWwx` · descriptor **FOXVOX-MSGCREDITS** (set; `*` is not allowed).
- Product **`prod_V6roj5r9lSifwj`** ("Inmate Messaging — Monthly", metadata `included_parts: 60`).
- Price **`price_1U6e5KF0MsCnMWwxtCTNIlGr`** — $29.00/mo recurring.
- IDs also stored in billing DB `config` table. `/stripe/setup-product` is idempotent.
- Portal endpoints: `/health`, `/migrate`, `/stripe/verify`, `/stripe/setup-product` (admin-token gated).

## Pricing model (decided)

$29/mo per inmate thread · **60 outbound message parts included** (real usage:
typical month 20–30 parts, one outlier at 93) · overage $0.50/part metered ·
1 part = one Securus message = one stamp. Stamps live on each customer's own
Securus account; auto-buy caps: refill <10, max 1/day, 4/week. Open question:
CDOC per-message reimbursement (Dennis to confirm).

## Messaging system state (production, healthy)

- Contacts: **sam** (65651103, en) · **ricardo** (67887839, es) · **denise**
  (75042801, en — auto-activated + welcomed 2026-08-18 via the staged-contact
  dropdown watcher; message #312).
- Full per-contact isolation (composite `(contact_id, tag)` document keys,
  scoped dedup, recipient name+id verification at compose; send path refuses
  to guess recipients).
- Stamp balance ~18. Stamp **autobuy engine staged** (`src/securus/stamps.mjs`,
  `/stamp-autobuy`): guarded, disabled, purchase path `notImplemented` until
  recon-verified selectors land. Hourly recon in phaseScan → state keys
  `stamp_purchase_recon` (so far: compose page shows only "Total Stamps N",
  no purchase link — next recon target: account/payment pages).
- Hourly dropdown snapshot → `contact_dropdown` state; auto-activates staged
  contacts and fires their `pending_welcome_{id}` message.
- AI usage metering live (`[USAGE]` logs, `/status.usage`, dashboard card).
- Known quirks: Securus login overlay intercepted submits (fixed: DOM-click +
  keyboard fallback + reload retries in auth.mjs); inbox occasionally renders
  0 rows (fixed: one reload+re-enumerate); worker deploys take 30s–2min to
  serve (poll before concluding failure); **never CLI-deploy a worker while a
  dashboard secret edit is in flight** (it raced once and dropped the secret).

## A2P 10DLC + signup page (2026-08-20, local session)

**Correction to the line above: 10DLC is NOT complete.** Read-only inventory of the personal Telnyx account
(the key `call-operations` uses) on 2026-08-20: **0 brands, 0 campaigns, 0 phone numbers**, 1 messaging
profile (`call-operations-sms`, `40019cf7-…`), balance $98.32. "telnyx connected" meant the account/key works,
not that a brand/campaign exists. Registration is now tooled and gated in a sibling repo:

- **`usai-dns/foxvox-a2p`** (`~/Projects/foxvox/foxvox-a2p`) — Telnyx 10DLC registrar CLI (brand → campaign
  → number assign), compliance pre-check, runbook + playbook, agent skill. Derived from the Forward Flow
  system-atlas pattern (ff-launcher/telnyx-worker/website-builder), rewritten as FoxVox-owned code.
  `config/brand.json` needs the LLC legal name (exactly as on the EIN letter), EIN, address, phone, email.
- **Opt-in lives on the real signup page**, served by this repo's `foxvox-portal` worker on **foxvox.ai** via
  zone routes (`portal/wrangler.toml`): `GET /signup` (account creation + two unchecked SMS consent boxes),
  `/privacy`, `/terms`, `POST /api/signup` → `signups` table in `foxvox-billing-db` (proof-of-consent:
  flags + sha256 of the exact consent strings + ip/ua/page). Consent strings: `portal/src/consent.mjs` —
  **byte-identical** to `foxvox-a2p/src/copy.mjs`; `a2p campaign precheck` fetches the live page and fails on
  drift. Declared sub-usecases: CUSTOMER_CARE + ACCOUNT_NOTIFICATION + MARKETING (LOW_VOLUME).
- The rest of foxvox.ai (the existing "Custom Websites" landing) is untouched — only those paths route to the worker.
- Tests: `npm test` runs `tests/unit.test.mjs` + `tests/portal.test.mjs` (opt-in compliance tripwire).

**Deploy + register sequence (needs the personal Cloudflare login — this machine's wrangler is logged into
a different account):**
```bash
npx wrangler login                                   # as Usai.dlh@gmail.com
cd portal && npx wrangler deploy                     # serves foxvox.ai/signup,/privacy,/terms
curl -s -X POST "https://foxvox-portal.usai-dlh.workers.dev/migrate?token=$ADMIN_TOKEN"   # creates signups table
cd ../../foxvox-a2p && node bin/a2p.mjs campaign precheck      # must be ok:true
node bin/a2p.mjs brand create --yes → brand status (VERIFIED) → campaign create --yes → campaign status → number order/assign
```
**Registered 2026-08-20 (from the local session):** brand `4b2001a0-2174-8de1-71b2-45e941ca375f`
(TCR `B9MX4MI`, FOXVOX LIMITED, EIN on file, VERIFIED in ~3 min) · campaign
`4b3001a0-2177-0cae-ebbd-c23df3dda154` (LOW_VOLUME; CUSTOMER_CARE + ACCOUNT_NOTIFICATION + MARKETING; submitted
`TCR_PENDING`). Poll with `node bin/a2p.mjs campaign status` in foxvox-a2p; `businessContactEmail`
foxone@foxvox.ai still needs its Telnyx/TCR verification link clicked. Portal ADMIN_TOKEN was rotated in that
session (value held by Dennis). Next: when `campaignStatus` = MNO_PROVISIONED → `a2p number order/assign`, then
build step 4 (SMS relay via `call-operations`) uses the assigned number.

## Website + payment portal (2026-08-20, local session) — build steps 1 + 5 (partial)

`foxvox-portal` now serves the WHOLE of **foxvox.ai** (route `foxvox.ai/*`; the old Pages landing is
shadowed — delete the route to restore it):
- `/` product site (hero = relayed-conversation demo, how it works, pricing $29/60 msgs/$0.50, FAQ) ·
  `/signup` account creation + 10DLC opt-in → **Stripe Checkout** (subscription, `price_1U6e5KF0MsCnMWwxtCTNIlGr`,
  ToS consent collected, `client_reference_id` = signups.id) · `/welcome?session_id=` confirms with Stripe,
  upserts `payers` + `subscriptions`, sets signed `fv_session` cookie (SESSION_SECRET, 30 d) ·
  `/account` status / renews-or-ends / message credits / SMS prefs / **Manage billing** (Stripe billing-portal
  session; falls back to `config.stripe_portal_login_url` if set) · `/privacy` `/terms` `/robots.txt`.
- `POST /api/stripe/webhook` — Stripe-Signature verified (HMAC, 5-min tolerance), idempotent via
  `stripe_events`; handles checkout.session.completed, customer.subscription.*, invoice.paid (→ +60
  `payer_ledger` grant keyed by invoice id), invoice.payment_failed (→ past_due), charge.refunded (full → −60),
  charge.dispute.created (→ paused). **Inert until `STRIPE_WEBHOOK_SECRET` is set.**
- Tables added: `subscriptions`, `payer_ledger` (per-payer credits; moves to per-inmate `ledger` at connect
  time — step 3/6), `stripe_events`; `signups.stripe_checkout_session_id`. `/migrate` is additive.
- Admin (ADMIN_TOKEN): `/admin/signups`, `/admin/payers`, `/admin/events`, `/stripe/verify`,
  `POST /stripe/setup-webhook` (needs `webhook_write` on the restricted key).
- Code: `portal/src/{index,pages,consent,stripe,session}.mjs`; tests `tests/portal.test.mjs` (43 checks).
- Verified live: pages 200, `POST /api/signup` → 303 to checkout.stripe.com (live session created, no charge),
  a2p precheck still green.

**Open (Dennis):**
1. Stripe webhook: either grant the restricted key "Webhook Endpoints write" (link in the setup-webhook error)
   and `curl -X POST https://foxvox-portal.usai-dlh.workers.dev/stripe/setup-webhook?token=…` (returns the
   signing secret once), or create it in Dashboard → Developers → Webhooks → `https://foxvox.ai/api/stripe/webhook`
   with the 8 events above. Then `printf '<whsec>' | npx wrangler secret put STRIPE_WEBHOOK_SECRET` (in portal/).
   Until then credits aren't granted automatically (the /welcome page still records the payer + subscription).
2. Stripe Dashboard → Settings → Billing → Customer portal: activate the no-code login link and store it:
   `INSERT OR REPLACE INTO config VALUES ('stripe_portal_login_url','https://billing.stripe.com/p/login/…',datetime('now'))`
   (gives signed-out users a "Manage billing" path). Also confirm the portal config allows cancel/update payment method.
3. Post-checkout email ("connect your contact" steps) — no email provider wired yet (foxvox.ai MX = Google
   Workspace; sending needs Resend/SES/etc. or a Cloudflare Email Worker).

## Build plan — step 2 onward (next work)

1. ~~**Checkout + webhooks**~~ DONE 2026-08-20 except STRIPE_WEBHOOK_SECRET (see above). Was: subscribe flow with
   `price_1U6e5KF0MsCnMWwxtCTNIlGr`; webhook endpoint for
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `charge.refunded`, `charge.dispute.created` → ledger writes + pause/resume;
   `STRIPE_WEBHOOK_SECRET` after registering the endpoint.
2. **Invite codes**: generation (8-char no-0/O/1/I), atomic single-use
   redemption, 30-day TTL, ≤3 open per inmate; `INVITE` command on the rail
   (parse like doc commands in the messaging worker).
3. **Balance gating in securus-agent**: bind billing DB read-only-by-policy;
   before generate → check `SUM(ledger.delta)`; per-part `usage` debit on
   confirmed send; low-water one-line notice + pause/resume per spec §7.
4. **SMS relay** (Telnyx is GO): service-bind `call-operations`, mirror inbound
   to customer's phone, reply-by-text, draft-approve mode, STOP/consent.
   Read `call-operations` source locally for the `/sms` contract first.
5. **Portal pages**: landing ✅, signup/checkout ✅, account ✅ (2026-08-20); remaining: redeem, connect-Securus (create new
   account [preferred] or take over existing — vault credentials AES-GCM under
   a worker-secret master key), fund, dashboard w/ tenant-scoped thread view.
6. **Multi-tenant core** in securus-agent: tenants table + per-tenant phase
   loop; migrate Dennis to tenant zero behind a flag.
7. **Pilot gate**: Sam + Denise families, admin-seeded codes, real money.

Open items on Dennis: CDOC reimbursement number, Colorado facility checklist
brain-dump, policy docs (ToS/privacy/refunds — credential custody + TCPA).

## Reference artifacts

- Proposal: https://claude.ai/code/artifact/415fe3af-dcc5-4d69-8346-fd8ffc971996
- Needs sheet: https://claude.ai/code/artifact/75d0d357-4113-4b0f-9b79-7424bc28a1a9
- Issue index: `docs/ISSUES.md` (open: #10 Twilio secrets no longer needed —
  supersede with Telnyx relay; #12 send-button throttle; #13 partially fixed;
  #14 backups; #21/#22 contact-scoping chores; #24 stamp autobuy staged)
