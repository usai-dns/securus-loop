# securus-loop

## mandatory reads

- **ARCHITECTURE.md** — read before planning or making changes. Contains full system design, message lifecycle, database schema, invariants, and file structure.

## tests

- **Run tests before pushing**: `npm test` (runs `tests/unit.test.mjs`)
- Tests cover: series detection, doc command parsing, message splitting, escalation detection
- Tests MUST pass on all code changes unless the change intentionally modifies tested behavior
- When adding new pure functions, add corresponding tests

## what this is

Autonomous messaging agent for Securus. Logs in, reads messages, generates replies as Dennis using Claude API, sends them back. Runs on Cloudflare Workers with Browser Rendering + D1.

Sam knows this system exists. The AI speaks as Dennis (first person).

## current status

**v4-queue architecture** — three-phase cron (SCAN → GENERATE → SEND) with persistent send_queue and inbound_series tables.

- Outbound multi-part messages tracked in `send_queue` (crash-safe, resumable)
- Inbound multi-part messages tracked in `inbound_series` (pattern: "message N/M")
- Dedup guards prevent re-generation and re-sending
- All messages preserved in D1 `messages` table

## critical discoveries

1. **stamp confirmation modal**: clicking Send opens a `.reveal-overlay` modal. MUST click `button:has-text("Confirm")` to actually send.
2. **no reply button**: message view has no reply — must navigate to Compose page separately
3. **open messages by clicking row**: click `td:nth-child(2)` (subject cell), NOT action column (that's delete)
4. **angular SPA**: hash routing (`#/...`), use `waitUntil: 'networkidle'` for page loads
5. **character limit**: 20,000 chars shared between subject + body
6. **message IDs**: in URL as `?messageId={ID}&siteId=09420` — use as dedup key in D1
7. **series pattern**: only "message N/M" triggers series collection — bare N/M does not

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
- **RICARDO CHALCHISEVILLA**: ID `67887839`

## user preferences

- never delete messages
- no co-author tags in git commits
- sam knows it's AI-augmented — fully autonomous, no approval step needed
- escalation rules: emergency/urgent messages trigger SMS to dennis instead of auto-reply
