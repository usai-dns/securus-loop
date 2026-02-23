# securus selectors

captured during local verification phase.
last updated: 2026-02-22

## login page

- url: `https://securustech.online/#/login`
- email field: `input[type="email"]` (placeholder: "user@email.com")
- password field: `input[type="password"]`
- submit button: `button[type="submit"]` (text: "Sign In")
- login error message: `[class*="error"], [role="alert"]`
- remember me checkbox: `input[type="checkbox"]`
- framework: Angular (ng-* classes)

## post-login landing

- url: `https://securustech.online/#/my-account`
- page title: "Securus - Friends and Family - My Account"
- inbox navigation link: `a[href*="inbox"]` (text: "LAUNCH", under eMessaging section)
- sign out link: `a[href*="login"]` (text: "Sign Out" / "SIGN OUT")

## inbox

- url: `https://securustech.online/#/products/emessage/inbox`
- message list container: `table`
- header row: `table tr:nth-child(1)` (From, Subject, Date, Action)
- individual message row: `table tr:nth-child(n+2)` (10 per page)
- message sender: `td:nth-child(1)` (text, e.g. "SAMUEL MULLIKIN")
- message subject: `td:nth-child(2)` (has responsive spans: `.hide-for-small-only` full, `.show-for-small-only` truncated)
- message date: `td:nth-child(3)` (format: "20 Feb 26")
- message action: `td:nth-child(4)` (contains delete icon only — `a[data-open="deleteMessage"] i.fa.fa-trash`)
- open message: click on `td:nth-child(2)` (subject cell) of any row — navigates to view
- pagination: `a[role="button"]` with text "2", "3", "Next PAGINATION_PAGE"
- sidebar nav: `select` with options (Compose, Contacts, Inbox, Sent, Draft, Total Stamps, Credit Card Info)

## message view

- url pattern: `#/products/emessage/inbox/view?messageId={ID}&siteId={SITE_ID}`
- site id (constant): `09420`
- sender name: `p.small-12.cell.font-bold.margin-bottom-half` (e.g. "SAMUEL MULLIKIN")
- recipient: `p.small-12.cell.margin-bottom-half` (e.g. "To: DENNIS HANSON")
- subject line: `p.small-12.cell.margin-bottom-half` (3rd paragraph, subject text with "...")
- date: appears after subject (format: "10 Feb 26")
- message body: `.message` class element (contains full message text)
- back to inbox sidebar link: `a[href*="inbox"]:not([href*="view"])`
- no reply button in message view — use Compose

## compose / reply

- url: `https://securustech.online/#/products/emessage/compose`
- recipient dropdown: `select#select-inmate` (name="selectInmate")
  - samuel mullikin value: `65651103`
  - ricardo chalchisevilla value: `67887839`
  - default option: "Select" (value: "")
- subject field: `input[name="subject"]`
- message body input: `textarea#message` (name="message", id="message")
- character limit: **20,000 characters** (shared between subject + body)
- character counter: displayed as "Characters left: {n}" near subject field
- attachments button: labeled "ATTACHMENTS" (no file input detected)
- return stamp checkbox: "Provide Return Stamp (1 Stamp)"
- send button: `button[type="submit"]` (text: "Send") — disabled until form valid
- **stamp usage confirmation modal**: `.reveal-overlay` appears after clicking Send
  - text: "You are using 1 of {n} stamps for Colorado State Prison System..."
  - confirm button: `button:has-text("Confirm")` — **must click to actually send**
  - cancel button: in modal, cancels send
  - also has "Provide Return Stamp (1 Stamp)" checkbox in modal
- cancel link: `a:has-text("Cancel")`
- stamp cost: **1 stamp per message** sent, optional return stamp costs 1 more
- stamps available shown after contact selection: "Colorado State Prison System: {n} Stamps Available"

## contacts

- samuel mullikin: ID `65651103`, facility: Colorado State Prison System, site: `09420`
- ricardo chalchisevilla: ID `67887839`

## account info

- account number: `36360439`
- phone: `+1 (719) 510-4200`
- available funds: `$33.00`
- account status: Active
- display name: DENNIS HANSON
