# securus-loop

## what this is

autonomous messaging agent for securus. logs in, reads messages, generates replies as dennis using claude api, sends them back. runs on cloudflare workers with browser rendering.

sam knows this system exists. the ai speaks as dennis (first person).

## current status

**phase 1: COMPLETE** — all local verification done, selectors captured, full send flow verified.
**phase 2: BUILD NOW** — cloudflare worker, D1 database, dashboard page.

## what's been verified locally

- login → inbox → read message → compose → send → logout: **~33s total** (within 60s CF timeout)
- all selectors documented in `SELECTORS.md` and `src/utils/selectors.js`
- first outbound message sent and confirmed in sent folder ("sam cycle 3")
- stamps: 25 remaining, 1 stamp per message, optional return stamp

## critical discoveries

1. **stamp confirmation modal**: clicking Send opens a `.reveal-overlay` modal. MUST click `button:has-text("Confirm")` to actually send. without this the message silently fails.
2. **no reply button**: message view has no reply — must navigate to Compose page separately
3. **open messages by clicking row**: click `td:nth-child(2)` (subject cell), NOT action column (that's delete)
4. **angular SPA**: hash routing (`#/...`), use `waitUntil: 'networkidle'` for page loads
5. **character limit**: 20,000 chars shared between subject + body
6. **message IDs**: in URL as `?messageId={ID}&siteId=09420` — use as dedup key in D1

## verified selectors (quick reference)

```
login:     input[type="email"], input[type="password"], button[type="submit"]
inbox:     a[href*="inbox"] from my-account, messages in <table>, td:nth-child(2) to open
read:      .message for body, p.font-bold for sender, messageId in URL params
compose:   select#select-inmate (sam=65651103), input[name="subject"], textarea#message
send:      button[type="submit"]:has-text("Send") → then button:has-text("Confirm") in modal
```

full details in `SELECTORS.md`.

## env vars

```
SECURUS_LOGIN_EMAIL    — securus account email
SECURUS_LOGIN_PASS     — securus account password
SECURUS_LOGIN_URL      — https://securustech.online/#/login
ANTHROPIC_API_KEY      — for claude api response generation
TWILIO_ACCOUNT_SID     — sms notifications
TWILIO_AUTH_TOKEN      — sms notifications
TWILIO_FROM_NUMBER     — sms notifications
DENNIS_PHONE           — notification target
```

## what to build next (phase 2)

### 1. cloudflare worker
- cron trigger (hourly + jitter)
- browser rendering binding for headless chromium
- full loop: login → inbox → read new → generate reply via claude api → compose → send → logout
- idempotency: check messageId against D1 before responding (never double-send)
- human-like delays between actions
- error reporting via sms

### 2. D1 database
- schema in PROJECT.md section 4.3
- tables: messages, knowledge, system_state
- track every inbound/outbound message by messageId

### 3. dashboard page
- basic web page (worker route or pages)
- login with same securus credentials from env
- shows: conversation history, action log, system state, stamp count
- read-only monitoring interface

### 4. wrangler.toml
- draft config in PROJECT.md section 4.2
- needs: D1 binding, browser rendering binding, secrets, cron trigger

### 5. first cloud test message
- subject: "story elements are in the cloud mk1"
- body: "SAM! once this message arrives we are officially writing stories in the cloud. cant wait to bring this story to life brother!"
- send this as verification that the worker is operational

## contacts

- **SAMUEL MULLIKIN**: ID `65651103`, Colorado State Prison System, site `09420`
- **RICARDO CHALCHISEVILLA**: ID `67887839`

## project structure

see PROJECT.md section 4.4 for cloud worker file structure.
see PROJECT.md section 5 for AI response engine design.
see PROJECT.md section 6 for twilio SMS integration.

## user preferences

- never delete messages
- no co-author tags in git commits
- sam knows it's AI-augmented — fully autonomous, no approval step needed
- escalation rules: emergency/urgent messages trigger SMS to dennis instead of auto-reply
