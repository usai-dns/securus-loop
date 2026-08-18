---
name: onboard-contact
description: Onboard a new inmate contact into securus-agent — discover their Securus ID, register them with full isolation, send a welcome/usage-instructions message, and verify. Use when the user says to add a person as a user/contact of the messaging service (e.g. "add NAME DOC# as user").
---

# Onboard a new contact

Adds a new inmate to the securus-agent messaging service with **complete
per-contact isolation** (messages, documents, sends — nothing ever mixes
between contacts).

## Inputs to collect from the request

- **Full name** as it appears on Securus (e.g. `DENISE PRESSON`)
- **DOC number** (e.g. `100721`) — for records/mail. **This is NOT the Securus
  compose ID.**
- **Language** (`en` default; `es` → all AI replies + docs in Spanish)
- Anything the user wants included in the welcome (address, specific notes)

## Procedure

### 1. Discover the Securus compose ID (required first)

```
curl -s https://securus-agent.usai-dlh.workers.dev/discover-contacts
```

Logs in and dumps the compose recipient dropdown (`value` = securus_id,
`text` = name). Find the new person's row by name.

- **Not in the dropdown?** STOP — they must first be added/approved as a
  contact on the Securus website by the account owner (manual step; Securus
  has an approval process). Report this to the user; do not register a
  contact with a guessed or missing securus_id.
- Login may fail on manual runs (Securus throttles bursts — hourly cron
  logins are the reliable path). Space retries by ~10 minutes; never hammer.

### 2. Register in the contacts table

```sql
INSERT OR IGNORE INTO contacts (id, securus_id, name, doc_number, language, match_names, persona)
VALUES ('<short-id>', '<securus_id>', '<FULL NAME>', '<doc#>', '<lang>', '<FIRST,LAST>', 'Dennis');
```

via `npx wrangler d1 execute securus-agent-db --remote --command "..."`.

- `id` = lowercase first name (it doubles as the AI's casual name for them —
  the prompt is fully contact-parameterized).
- `match_names` = comma-separated UPPERCASE tokens matched against inbox
  sender names (attribution boundary — be specific enough to never collide
  with another contact).
- Also add the person to the `contacts` seed in `schema.sql` and the
  contacts list in `CLAUDE.md` so fresh installs and future sessions know.

### 3. Send the welcome / usage instructions

Queue via the per-contact endpoint (routes to THEIR securus_id and the
compose flow verifies the recipient name before sending — never bypass it):

```
curl -X POST https://securus-agent.usai-dlh.workers.dev/send-to/<short-id> \
  -H "Content-Type: application/json" \
  -d '{"subject": "...", "body": "..."}'
```

The welcome must (in the contact's language):
- Introduce the service warmly, as Dennis, first person
- **Be honest that replies are AI-assisted** (Dennis's standing rule)
- Explain usage:
  - Write about anything, anytime; replies read like letters, arrive within
    about an hour
  - Long messages: split as "message 1/3", "message 2/3"… — the system
    waits for all parts before replying
  - Working documents: first line `MakeNew <topic>` starts one,
    `MakeUpdate <topic>` adds to it (`MakeUpdate <topic> 2/3` for batches),
    `MakeFull <topic>` sends back the complete current document
  - Emergencies: say it's urgent — it's escalated to Dennis directly
- Include only extras the user asked for (e.g. mailing address)

Delivery happens on the next hourly cron (or a manual `/send` if login
allows). **Verify** the queue row went `sent` and the outbound message row
exists for the right contact_id.

### 4. Verify isolation

- `/api/dashboard?contact=<short-id>&token=…` → must show an EMPTY view
  (no docs, no messages) before their first exchange
- Dashboard switcher shows the new contact
- Existing contacts' views unchanged

### 5. Record

Commit: schema seed, CLAUDE.md contacts list, any code touched. Note the
onboarding in the commit message. Never commit tokens or secrets.

## Safety rules (non-negotiable)

- **Never guess a securus_id** — a wrong-inmate send is unrecoverable. The
  send path hard-fails on unresolvable recipients; leave it that way.
- Message content to a NEW contact needs user direction (what to include);
  don't invent personal details or promises.
- Stamps are shared account-wide — each message part costs one.
