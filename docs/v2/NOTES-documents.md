# Wave 1-B — Documents v2 (provenance ledger): integration notes

> Built 2026-11-07 on branch `worktree-agent-ab5913b63905956f6` (off
> `claude/deploy-test-worker-TeBfE`). No edits to `src/index.js`, no deploy, no
> D1 changes. Spec: `docs/V2_ARCHITECTURE.md` §6 (F3, F4, F5), §11, §12.

## What changed

| File | Change |
|---|---|
| `src/db/documents.mjs` | sections split/render, `applyPatch`, `getSections`/`saveSections`, entries ledger, protection, archive, per-contact listing. `saveDocument` now refuses a `protected` doc unless `force: true`. |
| `src/ai/responder.mjs` | `buildDocumentPatch` (streamed, 16k max_tokens, usage kind `doc-patch`), `parseDocPatch` (pure), private `readTextStream`. `buildDocument` untouched. |
| `src/docs/commands.mjs` | `mentionedTags(body, known)` accepts `{ tag, title }` entries; matches hyphen/space variants and title word runs; drops a tag whose every mention is inside another tag's longer match. `tagAliasPatterns` exported. |
| `tests/unit.test.mjs` | 133 → 201 assertions (sections round-trip incl. code fences, applyPatch, archive naming, changelog, parseDocPatch, alias matching). |

## Migration SQL (add to the `migrations` array in `index.js` `/migrate`)

The runner already tolerates `duplicate column` / `already exists`, so these are
safe to re-run. `protected` may already exist in D1 (qualia-bible was restored
as protected on 11-07) — that is fine.

```js
"ALTER TABLE documents ADD COLUMN protected INTEGER DEFAULT 0",
"ALTER TABLE documents ADD COLUMN sections TEXT",
"ALTER TABLE documents ADD COLUMN changelog TEXT",
`CREATE TABLE IF NOT EXISTS document_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  author TEXT NOT NULL,
  inbound_id INTEGER,
  outbound_id INTEGER,
  summary TEXT,
  content TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`,
"CREATE INDEX IF NOT EXISTS idx_document_entries_doc ON document_entries(contact_id, tag, id)",
```

Also append the same statements to `schema.sql` (documents table + the new
table) so a fresh database matches.

## Exports and signatures

### `src/db/documents.mjs`

Unchanged contracts: `docTitle(tag)`, `getDocument(db, contactId, tag)`,
`listDocuments(db, contactId?)`, `getDocumentVersions(db, contactId, tag)`,
`changeNoteFor(command, prevLen, newLen)`.

```js
// changed: throws Error(/protected/) when the doc has protected = 1 and force is not set
saveDocument(db, { contactId, tag, title, content, changeNote, messageId, force = false }) → version

// pure
splitIntoSections(markdown) → [{ heading, body }]
  // splits on "## " lines (or "# " if the doc has no "##"); text before the first
  // heading → { heading: 'Overview' }; no headings at all → [{ heading: 'Document', body }].
  // Lines inside ``` / ~~~ fences are body. "###" and deeper stay inside bodies.
renderSections(sections) → markdown      // "## heading\n\nbody" blocks joined by blank lines
applyPatch(sections, patch) → sections   // NEW array; input untouched
  // patch = { section_updates: [{heading, body}], new_sections: [{heading, body, after?}], remove_sections?: [heading] }
  // heading match: case/whitespace-insensitive, leading "#"s ignored
  // update → replaces body; update of unknown heading → appended as a new section
  // new_sections → append, or insert after `after`; a new section whose heading exists replaces that body
  // only remove_sections ever drops a section
normalizeHeading(heading) → string
isoDate(date?) → 'YYYY-MM-DD'           // UTC; defaults to today
prependChangelog(changelog, entry, { date, version }) → text   // "- YYYY-MM-DD (vN): entry" newest first
archiveTagFor(tag, date?, n = 1) → `${tag}-archived-YYYYMMDD` (+ `-n` when n > 1)

// db
getSections(db, contactId, tag) → null | { sections, derived, changelog, protected, title, version, doc }
  // derived = true when `sections` column was null/invalid and sections came from splitIntoSections(content)
saveSections(db, { contactId, tag, title, sections, changelogEntry, changeNote?, messageId, date? }) → version
  // renders content, calls saveDocument (version bump + document_versions snapshot, change_note =
  // changeNote || first line of changelogEntry), then stores sections JSON + changelog. Throws on protected.
appendEntry(db, { contactId, tag, author, entryDate?, inboundId?, outboundId?, summary?, content? }) → entry id
  // author: 'ai' for the assistant, else the contact id ('sam', 'ricardo'); entryDate defaults to today
getEntries(db, contactId, tag, { limit = 50 }) → rows newest first
  // { id, entry_date, author, inbound_id, outbound_id, summary, content, content_len, created_at }
isProtected(db, contactId, tag) → bool
setProtected(db, contactId, tag, flag)
archiveDocument(db, contactId, tag, { date? }) → archiveTag | null
  // renames the documents row, its document_versions AND its document_entries to the archive tag
  // (one db.batch), sets protected = 1, title += " (archived YYYY-MM-DD)". Picks -2, -3… if taken.
listDocumentsForContact(db, contactId) → [{ tag, title, protected: bool, version, length }]
```

### `src/ai/responder.mjs`

```js
buildDocumentPatch(env, { tag, title, sections, newMaterial, command, authorName, language, entryDate })
  → { patch: { section_updates, new_sections }, changelog, replace }
  // command: 'makeupdate' (integrate; default) | 'makenew' (build initial sections; also used when sections is empty)
  //          | 'makefull' (whole rewrite — the ONE allowed case; replace = true: apply the patch to [] not to the current sections)
  // throws Error('doc-patch: …') on API/stream/JSON failure or when the patch touches nothing
  // records usage kind 'doc-patch'; max_tokens 16000; streamed
parseDocPatch(text) → { patch, changelog }      // pure; extracts the outermost {...}, normalizes shape
buildDocument(...)                               // unchanged
```

The system prompt enforces attribution: anything the author stated is recorded as
theirs; anything the assistant adds is marked `Assistant note:` / `(AI)` inside
the body. Bodies must use `###` or deeper for sub-headings so `##` stays a
section boundary on re-split.

### `src/docs/commands.mjs`

```js
mentionedTags(body, known) → [tag]
  // known: ['swarm', …] OR [{ tag: 'qualia-bible', title: 'Qualia Series Bible …' }, …]
  // matches: whole-word tag; tag with -/_ as spaces ("qualia bible"); any run of ≥ 2 consecutive
  // title words ("series bible"); the default "— working document" suffix is stripped and
  // generic words (working, document, the, of, …) can't match on their own.
  // a tag whose every mention lies inside another tag's longer mention is dropped
  // ("Qualia Series Bible" ⇒ ['qualia-bible'], not ['qualia-bible','qualia']).
tagAliasPatterns(tag, title) → [RegExp]
```

## Integration recipe for `src/index.js` (Wave 2)

### Imports

```js
import { getDocument, saveDocument, docTitle, changeNoteFor, getDocumentVersions,
         getSections, saveSections, applyPatch, renderSections, appendEntry, getEntries,
         archiveDocument, isProtected, listDocumentsForContact } from './db/documents.mjs';
import { …, buildDocument, buildDocumentPatch } from './ai/responder.mjs';
```

### 1. Protected check — before generating a reply for a doc command

Both command paths (series block ~L435 and single-message block ~L580) currently
run `generateResponse` and then `buildDocument`. Insert, as soon as
`effectiveCmd`/`docCmd` and `effectiveTag` are known:

```js
if ((cmd === 'makenew' || cmd === 'makeupdate') && effectiveTag && await isProtected(env.DB, contactId, effectiveTag)) {
  const name = effectiveTag.charAt(0).toUpperCase() + effectiveTag.slice(1);
  const body = `${name} is a protected reference document, so I didn't change it — it stays exactly as it is. ` +
    `If you want to build on it, send "MakeNew <newname>" and tell me to reference ${name}, ` +
    `or ask me to copy it into a working document.`;
  const parts = splitForSend(replySubject, body);
  await queueOutboundParts(env.DB, { inboundId: msg.id, seriesId: null, parts, docTag: effectiveTag, contactId, securusId: contact?.securus_id });
  generated++;
  results.push({ id: msg.id, status: 'protected_doc_refused', contact: contactId, tag: effectiveTag });
  continue;
}
```

Also drop protected docs from the patcher: never call `buildDocumentPatch` with
a protected doc's sections. `makefull` (send the current body) and references
(`<reference_document>`) still work on protected docs — that is their purpose.

### 2. MakeNew on an existing tag ⇒ archive, then build

Replace the `if (updated) await saveDocument(...)` block in both command paths
(~L446–450 series, ~L693–708 single) with:

```js
if ((cmd === 'makenew' || cmd === 'makeupdate') && effectiveTag) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let archivedAs = null;
    if (cmd === 'makenew') {
      archivedAs = await archiveDocument(env.DB, contactId, effectiveTag);   // null when nothing existed
      if (archivedAs) console.log(`makenew: archived ${contactId}/${effectiveTag} → ${archivedAs}`);
    }
    const cur = await getSections(env.DB, contactId, effectiveTag);          // null after archive / for a brand-new tag
    const title = cur?.title || docTitle(effectiveTag);

    // (a) ledger: what the author sent, dated, linked to the inbound
    await appendEntry(env.DB, { contactId, tag: effectiveTag, author: contactId, entryDate: today,
      inboundId: msg.id, content: bodyForAi, summary: (msg.subject || '').substring(0, 200) });

    // (b) patch, not rewrite
    const newMaterial = `Direction / notes:\n${bodyForAi}\n\n─────\n\nDrafted content (integrate this into the document):\n${aiResponse}`;
    const { patch, changelog, replace } = await buildDocumentPatch(env, {
      tag: effectiveTag, title, sections: cur?.sections || [], newMaterial,
      command: cur ? cmd : 'makenew', authorName: contactId, language: contact?.language, entryDate: today,
    });
    const next = applyPatch(replace ? [] : (cur?.sections || []), patch);

    // (c) persist: content rendered from sections, version bump, snapshot, changelog
    const prevLen = (cur?.doc?.content || '').length;
    const newLen = renderSections(next).length;   // or compute after save via getDocument
    docVersion = await saveSections(env.DB, { contactId, tag: effectiveTag, title, sections: next,
      changelogEntry: changelog || changeNoteFor(cmd, prevLen, newLen), changeNote: changeNoteFor(cmd, prevLen, newLen),
      messageId: msg.id, date: today });

    // (d) ledger: what the assistant contributed
    await appendEntry(env.DB, { contactId, tag: effectiveTag, author: 'ai', entryDate: today,
      inboundId: msg.id, summary: changelog || changeNoteFor(cmd, prevLen, newLen),
      content: aiResponse.substring(0, 20000) });

    if (archivedAs) results.push({ id: msg.id, status: 'doc_archived', archivedAs });
    console.log(`governing doc "${contactId}/${effectiveTag}" → v${docVersion} (${changelog})`);
  } catch (docErr) {
    console.error(`doc patch failed for "${contactId}/${effectiveTag}": ${docErr.message}`);
  }
}
```

Notes:
- `outboundId` for the `ai` entry is not known at GENERATE time (the outbound
  `messages` row is created in SEND). Either leave it null and link via
  `inbound_id`, or in phaseSend after `saveMessage` run
  `UPDATE document_entries SET outbound_id = ? WHERE inbound_id = ? AND author = 'ai' AND outbound_id IS NULL`.
- In the series path use `primaryId` / `combinedBody` in place of `msg.id` /
  `bodyForAi`, and `effectiveCmd` for `cmd`.
- The makenew acknowledgement text (`docAcknowledgment`) should mention the
  archive when `archivedAs` is set, e.g. "I've started a fresh Swarm document;
  the previous one is kept as swarm-archived-20261107."
- `buildDocument` stays for `/rebuild-doc` and `/assemble-doc`; those admin
  routes should also check `isProtected` (or pass `force: true` to
  `saveDocument` deliberately — never by default).

### 3. Lazy sections migration

No bulk migration is needed. `getSections` returns `derived: true` and a
`splitIntoSections(content)` result until the first `saveSections` for that tag
stores the JSON. Existing 130K-char docs already use `##` headings, so they land
as real sections on first update. A doc with no headings becomes one
`Document` section — the optional `/migrate-doc-sections?tag=` pass from §6 can
ask the model to split it later (not built in this wave).

Because `content` is now rendered from sections, a legacy doc whose body
started with `# Title` keeps that line inside the `Overview` section body, so
nothing is lost; the rendered doc gains `## Overview` as its first heading.

### 4. References: titles + protected/archived docs

`loadPlainLanguageRefs` (~L83) currently does
`mentionedTags(body, rows.map(r => r.tag))` over `SELECT tag FROM documents`.
Change to:

```js
const rows = await listDocumentsForContact(env.DB, contactId);
const candidates = mentionedTags(body, rows.filter(r => !/-archived-\d{8}/.test(r.tag)))  // {tag,title} objects
  .filter(t => t !== excludeTag && !have.has(t));
```

so "series bible" / "qualia bible" resolve to `qualia-bible`. Archived copies are
excluded from plain-language matching (their titles duplicate the live doc's
words); they remain reachable by an explicit `MakeReference swarm-archived-20261107`.

### 5. Dashboard / API

- `/api/document/{tag}` — add `entries: await getEntries(env.DB, contactId, tag, { limit: 100 })`
  and expose `doc.changelog`, `doc.protected`, `doc.sections` (already on the row).
- Document tab (`dashboard.mjs` `loadDocView`): show a **Protected** badge when
  `doc.protected`; render `changelog` as a "Change log" list above the body
  (one line per entry, newest first — it is already formatted); offer a
  per-section view by parsing `doc.sections` (collapsed headings) instead of a
  single `textContent` dump.
- New **Entries** sub-tab (or a third column): rows from `document_entries`,
  badge `author === 'ai' ? 'Assistant' : contact name`, `entry_date`,
  `summary`, link `#inbound_id` / `#outbound_id` to the existing message
  viewer, expandable `content`.
- `/api/dashboard` document list: include `protected` and `version` from
  `listDocumentsForContact` so archived/protected docs are visibly distinct
  (grey, lock icon) and sorted after live docs.

## Design decisions the brief left open

1. **`saveDocument` guards protected docs too** (opt-out `force: true`). The
   brief only required `saveSections` to refuse, but `/rebuild-doc`,
   `/assemble-doc` and `/import-doc` all write through `saveDocument` and are
   exactly how a second F3 would happen. Existing behaviour is identical for
   every unprotected doc.
2. **Archive moves `document_entries` as well** as `document_versions` — the
   ledger belongs to the body it describes. The archive gets a dated title
   suffix so it is distinguishable in lists.
3. **`makefull` in `buildDocumentPatch` means full rewrite** (per brief) and is
   signalled with `replace: true`; the caller applies the patch to `[]`. Note
   the current `makefull` command path in `index.js` *sends* the doc and does
   not rebuild — nothing there needs to call the patcher.
4. **`applyPatch` never duplicates a heading**: a `new_sections` entry whose
   heading already exists replaces that body (the model occasionally puts an
   update in the wrong list). Unknown headings in `section_updates` are
   appended rather than dropped.
5. **Changelog is plain text, newest first** (`- YYYY-MM-DD (vN): …`), not JSON,
   so the dashboard can print it verbatim and `document_versions.change_note`
   gets the first line.
6. **Entry author is `'ai'` or the contact id**, not a fixed `'sam'`, so Ricardo's
   documents attribute correctly.
7. **`mentionedTags` containment rule**: a shorter tag found only inside a longer
   tag's mention is dropped (keeps the resolver from being offered both the
   121K `qualia` doc and the 436K `qualia-bible` for one phrase). A standalone
   mention of the shorter tag elsewhere in the body still surfaces it.
8. **Word boundaries treat `_` like `-`** (the old `\b` treated `_` as a word
   character). Tags are `\w+` from `parseDocCommand` plus archive hyphens, so
   this only matters for hand-named imports.
