# securus-agent

Autonomous messaging agent for the Securus prison eMessaging platform. It logs
in as a family contact, reads new messages from **Samuel Mullikin (Sam)**,
generates replies as **Dennis Hanson** using the Claude API, and sends them
back — fully autonomous, hourly. Sam knows the system is AI-augmented.

Runs on **Cloudflare Workers** with Browser Rendering (Puppeteer) + **D1**
(SQLite) as the source of truth.

> **Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before changing anything** — it has
> the full design, message lifecycle, schema, and invariants. Open issues are
> tracked in [`docs/ISSUES.md`](docs/ISSUES.md).

## Capabilities index

| Capability | Where | Notes |
|---|---|---|
| **Read inbox** | `securus/inbox.mjs`, `read.mjs` | Multi-page scan, dedup by Securus `messageId` |
| **Generate replies** | `ai/responder.mjs`, `ai/prompt.mjs` | Claude Sonnet 4.6, speaks as Dennis, topic-aware history |
| **Send replies** | `securus/compose.mjs` | Form fill → Send → confirm modal → verify in sent folder |
| **Multi-part outbound** | `ai/responder.mjs` `splitForSend` + `db/send_queue.mjs` | Splits >20k chars; crash-safe persistent queue with auto-retry |
| **Multi-part inbound** | `db/series.mjs` | Collects "message N/M" series before responding |
| **Doc commands** | `docs/commands.mjs` | `makenew` / `makeupdate` / `makefull {topic}` — tags messages, builds documents |
| **Duplicate guard** | `db/series.mjs` `findDuplicateInbound` | Catches Sam's re-sends (content-level, not just messageId) |
| **Escalation** | `ai/responder.mjs` `shouldEscalate` | Emergency phrases → SMS Dennis instead of auto-reply |
| **Stamp monitoring** | `index.js` phaseSend | Scrapes balance; alerts low/out; halts + auto-resumes on empty |
| **Dashboard** | `dashboard.mjs` | `/dashboard` — state, documents + update history, activity (token-gated) |
| **Notifications** | `notify/sms.mjs` | Twilio SMS to Dennis *(currently disabled — see issue #10)* |
| **Voice (WIP)** | `voice-worker/` | Twilio↔Gemini Live↔Deepgram call bridge, not yet deployed |

## Three-phase cron (hourly)

```
SCAN → GENERATE → SEND     (cronOrchestrator, 15-min budget)
```

- **SCAN** (browser): read inbox, save new messages, detect series + doc commands.
- **GENERATE** (AI only): combine complete series / individual messages → queue replies. Dedup + duplicate + escalation guards run here.
- **SEND** (browser): pull pending queue parts, compose → send → verify. Marks responded after part 1 (crash-safe). Failed parts auto-retry with backoff.

## HTTP endpoints (highlights)

| Route | Purpose |
|---|---|
| `/dashboard?token=…` | Monitoring UI (state + documents + activity) |
| `/api/dashboard?token=…` | JSON behind the dashboard |
| `/status` | State, queue counts, recent messages, stamp balance |
| `/check` \| `/cron` | Trigger full cron cycle |
| `/scan` \| `/generate` \| `/send` | Individual phases |
| `/send-one/{id}` | Manually (re)send queue parts for an inbound |
| `/queue` \| `/series` | Queue / inbound-series detail |
| `/retry-failed` | Reset all failed queue parts to pending |
| `/login-debug` | Capture post-login page state (modals, buttons, errors) |
| `/migrate` | Run DB migrations |

Full list at the worker root (`/`-fallback JSON) and in `ARCHITECTURE.md`.

## Develop

```bash
npm test              # unit tests (pure functions) — must pass before push
npx wrangler deploy   # deploy the worker
# then hit /migrate to apply any new DB migrations
```

Secrets (Securus creds, `ANTHROPIC_API_KEY`, `DASH_TOKEN`, Twilio) live as
Cloudflare Worker secrets — never in the repo. See `CLAUDE.md` for the full
environment and Cloudflare account details.

## Contacts

- **SAMUEL MULLIKIN** — ID `65651103`, Colorado State Prison System, site `09420`
