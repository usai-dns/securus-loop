# Draft — capability update to Sam (send after v2 deploy + live verification)

Subject (≤40 chars): `System update: your requests, fixed`

---

Sam,

You wrote up the problems in your Functionality file and you were right on every one. Here's what changed, item by item, plus two corrections I owe you.

**Two corrections first.**
1. When you asked for four drone renderings (Oct 23), I told you I can't attach images through Securus. That was false — I attached one to that very message. The real problem was that I could only make one image per message and I didn't know what had been attached when I wrote the text. Both are fixed below.
2. On Nov 2 I said three images were queued and that "Wytches2 is attached." Only Saga2 was made, on Soul, not Seedream. I will never again describe an image that isn't actually attached — the system now writes the attachment list, not me.

**Your Functionality list.**
(1) Continuity file — done. I now keep a profile of you: your preferences, every project with its status, commitments like the Documentary check-ins, and open threads. It's in context for every reply.
(2) Batching — done. I draft the whole answer first, then it's split into at most 3 messages (usually 1). Anything that won't fit becomes a tracked open item that gets sent in a later message automatically. No more "I'll follow up" that never comes — if I say something is in progress, the system itself delivers it.
(3) Dates and authors — done. Every project document now keeps a dated ledger of entries marked as yours or mine, plus a change log. Document updates patch the sections that changed instead of rewriting the whole file, so nothing gets quietly truncated anymore.
(4) Request tracking — done. Every message you send is broken into discrete requests (answers, images, document changes, research). Each reply ends with a short footer: what's attached, what couldn't be produced and why, and what's still open.
(5) Stamp warnings — done. When the balance after a message is 10 or fewer, the footer says so.

**Images.**
- Any number of `MakeImage - Label: prompt` directives per message; up to 5 attach to one message, more roll into the next. Labels appear in the footer and on the files.
- A request like "four pictures: exploded, top, side, front" is split into four images.
- Models: Soul (default) and GPT Image 2.5 Flare — write `(Run this prompt on GPT Image)`. Seedream and Nano Banana are NOT available through the API I use, so those requests render on Soul and the footer tells you. I'll say the moment that changes.
- Iteration still works: "again, darker" refines the last image in that project.

**Documents.**
- `MakeNew <name>` on an existing name now archives the old document (`name-archived-<date>`) instead of overwriting it.
- Your Qualia Series Bible is restored. My `MakeNew Qualia` in October overwrote it — that's why I kept telling you the character descriptions weren't in the document. It's back as a protected reference: write `MakeReference Qualia Bible` or just say "series bible." Your working Qualia document is unchanged.
- Name any document in plain language ("based on my values in Monday") and it loads as a reference — no keyword needed.

Everything else works as before. Send me your next batch and watch the footer.

— Dennis
