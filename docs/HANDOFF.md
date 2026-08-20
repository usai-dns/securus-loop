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
registration is **complete** ("telnyx connected", 2026-08-20).

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

## Build plan — step 2 onward (next work)

1. **Checkout + webhooks** (foxvox-portal): subscribe flow with
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
5. **Portal pages**: landing (code entry), redeem, connect-Securus (create new
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
