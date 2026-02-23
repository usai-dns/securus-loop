# securus-agent

## autonomous conversational agent for securus messaging

**project owner:** dennis
**status:** phase 1 — local verification
**created:** 2026-02-22

---

## 1. PURPOSE

build an autonomous system that:

1. logs into securus on a randomized schedule (~1hr interval)
2. navigates to the message inbox
3. reads new messages from any contact
4. sends SMS notification to dennis when new messages arrive
5. generates first-person responses as dennis using claude api with full conversation history
6. sends responses back through securus
7. maintains a persistent conversation log and growing knowledge base
8. eventually supports printing and mailing physical documents

sam knows this system exists. the ai speaks as dennis (first person) — this is augmented dennis, not a separate entity.

---

## 2. ARCHITECTURE OVERVIEW

### local phase (current)

```
local machine (playwright, headed browser)
  → securus login
  → inbox navigation
  → message reading
  → message composition + sending
  → selector/flow documentation
  → screenshots at every step
```

### cloud phase (after local verification)

```
cloudflare worker (cron trigger, randomized interval)
  → browser rendering (puppeteer/playwright binding)
    → securus login
    → inbox check
    → read new messages
  → d1 database
    → conversation_log (full message history)
    → knowledge_base (extracted topics, entities, context)
    → system_state (last check time, session metadata)
  → claude api
    → system prompt (dennis voice, relationship context, boundaries)
    → conversation history retrieval
    → knowledge base context injection
    → response generation
  → browser rendering (continued session)
    → compose and send reply via securus
  → twilio api
    → sms notification to dennis on new messages
```

### key constraint: cloudflare browser rendering

- workers paid plan required
- 30 concurrent browser sessions, 30 new instances/minute
- browser times out after 60s inactivity (extendable to 10min with keep_alive)
- full login → read → reply loop must complete within timeout
- browser rendering requests are identified as bot — securus bot detection is unknown risk
- puppeteer and playwright both supported via worker bindings

---

## 3. PHASE 1 — LOCAL VERIFICATION

### 3.1 environment setup

```bash
mkdir securus-agent
cd securus-agent
npm init -y
npm install playwright dotenv
npx playwright install chromium
```

**.env**

```
SECURUS_USERNAME=<your_username>
SECURUS_PASSWORD=<your_password>
SECURUS_URL=<securus_portal_url>
SAM_CONTACT_NAME=<sam_display_name_in_securus>
```

**.gitignore**

```
node_modules/
.env
screenshots/
```

### 3.2 verification checklist

each item must pass before moving to cloud phase. the local script runs headed (visible browser) and captures screenshots at every step.

#### authentication flow

- [ ] navigate to securus login page
- [ ] fill username field (capture selector)
- [ ] fill password field (capture selector)
- [ ] submit login form (capture selector)
- [ ] detect successful login — what does the post-login page look like?
- [ ] handle 2FA if present — document what appears
- [ ] handle CAPTCHA if present — document what appears
- [ ] handle "session already active" or "account locked" edge cases
- [ ] screenshot: login page
- [ ] screenshot: post-login landing page

#### inbox navigation

- [ ] navigate from landing page to message inbox (capture URL path and selectors)
- [ ] identify message list container (capture selector)
- [ ] enumerate visible messages: sender, timestamp, preview/subject
- [ ] distinguish read vs unread messages
- [ ] identify messages from sam vs other contacts
- [ ] handle pagination if inbox has multiple pages
- [ ] handle empty inbox state
- [ ] screenshot: inbox view
- [ ] screenshot: message list with metadata visible

#### message reading

- [ ] click into / open a specific message (capture selector)
- [ ] extract full message body text
- [ ] extract sender name
- [ ] extract timestamp
- [ ] extract any other metadata (message id, thread id, read status)
- [ ] navigate back to inbox after reading
- [ ] read multiple messages in sequence without breaking navigation
- [ ] screenshot: individual message view

#### message composition and sending

- [ ] navigate to compose / reply interface (is it reply-in-thread or new compose?)
- [ ] select sam as recipient (or confirm reply stays in thread)
- [ ] fill message body field (capture selector)
- [ ] document max character limit on messages
- [ ] click send (capture selector)
- [ ] confirm message was sent — what does confirmation look like?
- [ ] handle send failure gracefully
- [ ] screenshot: compose view
- [ ] screenshot: send confirmation

#### full loop integration

- [ ] complete loop: login → inbox → read new → compose reply → send → logout
- [ ] full loop completes in under 60 seconds (cloudflare browser timeout)
- [ ] script is idempotent — running twice doesn't double-send
- [ ] all selectors documented in SELECTORS.md
- [ ] all URLs and navigation paths documented

#### data capture for d1 schema

- [ ] document exact fields available per message
- [ ] document character limits on outgoing messages
- [ ] document rate limits on sending (messages per day/hour)
- [ ] document whether messages are threaded or flat
- [ ] document any message ID or thread ID system

### 3.3 local test script structure

```
securus-agent/
├── .env
├── .gitignore
├── package.json
├── PROJECT.md                  ← this file
├── SELECTORS.md                ← populated during verification
├── screenshots/                ← auto-captured during runs
├── src/
│   ├── verify-auth.js          ← step 1: login only
│   ├── verify-inbox.js         ← step 2: login + inbox navigation
│   ├── verify-read.js          ← step 3: login + inbox + read message
│   ├── verify-compose.js       ← step 4: login + inbox + compose + send
│   ├── verify-full-loop.js     ← step 5: complete loop
│   └── utils/
│       ├── browser.js          ← browser launch + screenshot helpers
│       └── selectors.js        ← all captured selectors (exported)
└── docs/
    └── flow-notes.md           ← manual observations during verification
```

each verify script builds on the previous one. run them in order. capture screenshots and selector info as you go. populate SELECTORS.md and selectors.js incrementally.

### 3.4 SELECTORS.md template

```markdown
# securus selectors

captured during local verification phase.
last updated: <date>

## login page

- url: ``
- username field: ``
- password field: ``
- submit button: ``
- login error message: ``

## post-login landing

- url: ``
- inbox navigation link: ``

## inbox

- url: ``
- message list container: ``
- individual message row: ``
- message sender: ``
- message timestamp: ``
- message preview: ``
- unread indicator: ``
- pagination next: ``
- pagination previous: ``

## message view

- url pattern: ``
- message body: ``
- sender name: ``
- timestamp: ``
- message id (if available): ``
- back to inbox: ``

## compose / reply

- url: ``
- recipient field (if new compose): ``
- message body input: ``
- send button: ``
- send confirmation indicator: ``
- character limit: ``
- character counter (if visible): ``
```

---

## 4. PHASE 2 — CLOUD DEPLOYMENT (CLOUDFLARE)

after local verification passes, migrate to cloudflare workers.

### 4.1 cloudflare resources needed

| resource | purpose |
|----------|---------|
| worker (cron trigger) | scheduled execution with randomized interval |
| browser rendering binding | headless chromium for securus automation |
| d1 database | conversation log, knowledge base, system state |
| secrets | securus credentials, claude api key, twilio credentials |

### 4.2 wrangler.toml (draft)

```toml
name = "securus-agent"
main = "src/index.js"
compatibility_date = "2026-02-22"

[triggers]
crons = ["0 * * * *"]  # every hour — jitter added in code

[[d1_databases]]
binding = "DB"
database_name = "securus-agent-db"
database_id = "<created_during_setup>"

[browser]
binding = "BROWSER"

[vars]
SAM_CONTACT_NAME = "<sam_display_name>"
DENNIS_PHONE = "<notification_number>"
```

### 4.3 d1 schema

```sql
-- conversation log: every message in and out
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,              -- securus message id if available
  direction TEXT NOT NULL,       -- 'inbound' or 'outbound'
  sender TEXT NOT NULL,          -- contact name
  body TEXT NOT NULL,
  timestamp TEXT NOT NULL,       -- ISO 8601
  read_at TEXT,                  -- when the agent read it
  responded_at TEXT,             -- when the agent sent a reply
  response_id INTEGER,          -- links to the outbound message id
  created_at TEXT DEFAULT (datetime('now'))
);

-- knowledge base: extracted context that grows over time
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,            -- extracted topic or entity
  content TEXT NOT NULL,          -- what we know about it
  source_message_id INTEGER,     -- which message this came from
  confidence REAL DEFAULT 1.0,   -- how certain (1.0 = stated directly)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_message_id) REFERENCES messages(id)
);

-- system state: operational metadata
CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- initial state entries
INSERT INTO system_state (key, value) VALUES
  ('last_check', ''),
  ('last_message_id', ''),
  ('total_checks', '0'),
  ('total_messages_sent', '0'),
  ('last_error', '');

-- indexes
CREATE INDEX idx_messages_direction ON messages(direction);
CREATE INDEX idx_messages_sender ON messages(sender);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_knowledge_topic ON knowledge(topic);
```

### 4.4 worker structure (cloud phase)

```
securus-agent/
├── wrangler.toml
├── package.json
├── src/
│   ├── index.js                ← cron handler entry point
│   ├── securus/
│   │   ├── auth.js             ← login flow (from verified selectors)
│   │   ├── inbox.js            ← inbox navigation + message enumeration
│   │   ├── read.js             ← message reading + extraction
│   │   └── compose.js          ← message composition + sending
│   ├── ai/
│   │   ├── responder.js        ← claude api call with context assembly
│   │   ├── knowledge.js        ← knowledge extraction from messages
│   │   └── prompt.js           ← system prompt and context builder
│   ├── notify/
│   │   └── sms.js              ← twilio sms notification
│   ├── db/
│   │   ├── messages.js         ← message CRUD
│   │   ├── knowledge.js        ← knowledge base CRUD
│   │   └── state.js            ← system state management
│   └── utils/
│       ├── jitter.js           ← randomize execution timing
│       └── selectors.js        ← all securus selectors (from local phase)
└── schema.sql
```

### 4.5 cron with jitter

the worker fires every hour on the cron trigger. internally, it adds random delay (0-15 minutes) before executing to avoid predictable patterns.

```javascript
export default {
  async scheduled(event, env, ctx) {
    // random delay 0-15 minutes to vary login timing
    const jitterMs = Math.floor(Math.random() * 15 * 60 * 1000);
    await new Promise(resolve => setTimeout(resolve, jitterMs));

    // execute the check
    await checkAndRespond(env);
  }
};
```

---

## 5. AI RESPONSE ENGINE

### 5.1 system prompt structure

```
you are dennis. you are responding to messages from sam through securus.

<relationship_context>
{who sam is, how long you've known each other, typical topics, tone}
</relationship_context>

<conversation_history>
{recent messages from d1, reverse chronological, trimmed to fit context window}
</conversation_history>

<knowledge_base>
{relevant extracted knowledge entries based on current message content}
</knowledge_base>

<boundaries>
{topics to avoid, things that trigger sms escalation instead of auto-response}
</boundaries>

<current_message>
from sam, received {timestamp}:
{message body}
</current_message>

respond as dennis. first person. natural voice. match the tone and depth appropriate to what sam said. keep within securus character limits ({limit} characters).
```

### 5.2 context assembly logic

1. receive new message from sam
2. query d1 for last N messages (conversation history)
3. query knowledge base for entries related to current message content
4. assemble system prompt with history + knowledge + boundaries
5. call claude api (claude-sonnet-4-20250514 for cost efficiency at this volume)
6. extract response text
7. validate response is within character limits
8. store response in d1
9. send via securus

### 5.3 knowledge extraction

after each inbound message, run a secondary claude call:

```
given this message from sam:
{message body}

and existing knowledge base:
{current knowledge entries}

extract any new facts, topics, preferences, or context worth remembering.
return as JSON array of {topic, content, confidence} objects.
return empty array if nothing new worth storing.
```

store results in knowledge table. this grows the agent's contextual understanding over time.

### 5.4 escalation rules

some messages should trigger SMS to dennis instead of (or in addition to) auto-response:

- messages mentioning emergency, urgent, or crisis
- messages asking for specific actions dennis needs to take externally
- messages the AI is uncertain how to respond to
- messages from contacts other than sam (notify only, no auto-response unless configured)
- first message from a new contact

escalation sends SMS with the message content and waits for dennis to respond manually (or approves the AI draft in a future version).

---

## 6. SMS NOTIFICATION

### 6.1 twilio integration

```javascript
async function notifyDennis(env, sender, messagePreview) {
  const body = `securus: new message from ${sender}\n\n${messagePreview.substring(0, 160)}`;

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      To: env.DENNIS_PHONE,
      From: env.TWILIO_FROM_NUMBER,
      Body: body
    })
  });
}
```

---

## 7. FUTURE PHASES

### phase 3 — document printing and mailing

- integrate lob.com api for print-and-mail
- generate PDF from conversation context or specific content
- mail physical letters to sam's facility
- triggered by sam's requests parsed from messages ("can you send me..." / "print this...")

### phase 4 — knowledge base enrichment

- semantic search over conversation history
- topic clustering and relationship mapping
- proactive context surfacing ("sam mentioned X three weeks ago, might be relevant")
- conversation summarization for dennis review

### phase 5 — multi-contact support

- configure auto-response for additional contacts
- per-contact voice/tone/boundary settings
- contact-specific knowledge bases

---

## 8. RISKS AND MITIGATIONS

| risk | severity | mitigation |
|------|----------|------------|
| securus bot detection | high | randomized timing, realistic user-agent, human-like delays between actions |
| securus UI changes break selectors | medium | selector validation before each action, error reporting via sms |
| AI sends inappropriate response | medium | content boundaries in system prompt, escalation rules, full audit log |
| account lockout from automated login | medium | session reuse where possible, backoff on auth failures, sms alert on lockout |
| securus rate limits on messaging | low | track send rate, respect limits, queue responses if needed |
| cloudflare browser rendering 60s timeout | low | verified during local phase that full loop < 60s; keep_alive extends to 10min |

---

## 9. GETTING STARTED

1. clone or create the project directory
2. run `npm init -y && npm install playwright dotenv && npx playwright install chromium`
3. create `.env` with securus credentials
4. populate securus URL — determine which portal: `securustech.net`, `securustech.online`, or facility-specific
5. run `src/verify-auth.js` — watch the browser, capture selectors
6. work through verification checklist step by step
7. populate SELECTORS.md as you go
8. once full loop verified, report back with selectors and timing data
9. we build the cloudflare worker from verified knowledge

---

## 10. DECISION LOG

| date | decision | rationale |
|------|----------|-----------|
| 2026-02-22 | fully autonomous (no approval step) | sam knows it's AI-augmented. trust the system prompt boundaries. |
| 2026-02-22 | cloudflare workers + browser rendering | keeps entire stack on CF. browser rendering supports puppeteer/playwright. |
| 2026-02-22 | local verification first | must capture selectors and validate timing before committing to cloud architecture |
| 2026-02-22 | claude-sonnet for response generation | cost efficient at low volume. upgrade to opus if quality needs it. |
| 2026-02-22 | d1 for storage | native CF binding, SQL interface, good enough for conversation log + knowledge base |
| 2026-02-22 | sms notification on all new messages | dennis maintains awareness without logging into securus manually |
