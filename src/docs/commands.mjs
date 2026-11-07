// Parse doc commands from inbound messages
// makenew {name} — create a new topic document
// makeupdate {name} — append to an existing topic document
// makeupdate {name} N/M — part N of M in a batch (wait for all M before responding)
// makefull {name} {request} — generate a full-length document, auto-split into multiple emails

export function parseDocCommand(messageBody) {
  if (!messageBody) return { command: null, docTag: null, cleanBody: messageBody, batch: null };

  const lines = messageBody.split('\n');
  const firstLine = lines[0].trim();
  const firstLineLower = firstLine.toLowerCase();
  const cleanBody = lines.slice(1).join('\n').trim();

  // match: makefull {word} — long-form document request
  const fullMatch = firstLineLower.match(/^makefull\s+(\w+)/i);
  if (fullMatch) {
    return {
      command: 'makefull',
      docTag: fullMatch[1].toLowerCase(),
      cleanBody,
      batch: null,
    };
  }

  // match: makenew {word}
  const newMatch = firstLineLower.match(/^makenew\s+(\w+)/i);
  if (newMatch) {
    return {
      command: 'makenew',
      docTag: newMatch[1].toLowerCase(),
      cleanBody,
      batch: null,
    };
  }

  // match: makeupdate {word} [N/M] — with optional batch indicator
  const updateMatch = firstLineLower.match(/^makeupdate\s+(\w+)/i);
  if (updateMatch) {
    const batchMatch = firstLine.match(/(\d+)\s*\/\s*(\d+)/);
    const batch = batchMatch
      ? { part: parseInt(batchMatch[1], 10), total: parseInt(batchMatch[2], 10) }
      : null;

    return {
      command: 'makeupdate',
      docTag: updateMatch[1].toLowerCase(),
      cleanBody,
      batch,
    };
  }

  return { command: null, docTag: null, cleanBody: messageBody, batch: null };
}

// Build the acknowledgment prefix for the AI response based on the doc command
export function docAcknowledgment(command, docTag, batchInfo) {
  if (!command || !docTag) return '';

  const name = docTag.charAt(0).toUpperCase() + docTag.slice(1);

  if (command === 'makenew') {
    return `I've started a new ${name} document and added your notes and my research/responses to it.\n\n`;
  }
  if (command === 'makeupdate') {
    if (batchInfo) {
      return `I've received and combined all ${batchInfo.total} parts of your ${name} update and added everything to your document along with my research/responses.\n\n`;
    }
    return `I've updated your ${name} document with these notes and my responses.\n\n`;
  }
  if (command === 'makefull') {
    return `Here's the full ${name} document you requested. It's split across multiple messages due to the character limit — read them in order.\n\n`;
  }
  return '';
}

// Parse MakeReference directives — Sam's request (2026-10-10): pull OTHER
// topics' governing documents into context before responding / updating.
// Fuzzy by design (he may write it many ways): matches lines like
//   MakeReference Swarm        make reference swarm, monday
//   Reference: Monday          makereference swarm monday
// anywhere in the first 8 lines. Returns { refs: [tags], cleanBody } with the
// directive lines stripped so they don't pollute the message content.
// Which known document tags does this body mention as whole words?
// Pure prefilter for plain-language reference resolution — a hit here is only
// a CANDIDATE (e.g. "see you monday" mentions the monday tag); the LLM
// resolver confirms whether the sender wants the document used as context.
//
// `known` is an array of tag strings, or of { tag, title }. A tag matches on
// the tag itself, on the tag with hyphens as spaces ("qualia bible" ⇒
// qualia-bible), and — when the title has ≥ 2 meaningful words — on any run of
// two or more consecutive title words ("series bible" ⇒ a doc titled "Qualia
// Series Bible …"). Returns the tags as given.
const TITLE_STOPWORDS = new Set(['working', 'document', 'doc', 'the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'my', 'from', 'with', 'by', 'at', 'archived', 'restored', 'file', 'notes', 'project']);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRe(words) {
  return new RegExp(`(?<![a-z0-9])${words.map(escapeRe).join('[\\s_-]+')}(?![a-z0-9])`, 'i');
}

export function tagAliasPatterns(tag, title) {
  const patterns = [];
  const t = String(tag || '').trim();
  if (!t) return patterns;
  patterns.push(phraseRe(t.split(/[-_\s]+/).filter(Boolean)));
  const words = String(title || '')
    .replace(/[—–-]\s*working document\s*$/i, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const meaningful = words.filter(w => !TITLE_STOPWORDS.has(w));
  if (words.length >= 2 && meaningful.length >= 1) {
    for (let i = 0; i < words.length - 1; i++) {
      for (let j = i + 2; j <= words.length; j++) {
        const run = words.slice(i, j);
        if (run.some(w => !TITLE_STOPWORDS.has(w) && w.length > 1)) patterns.push(phraseRe(run));
      }
    }
  }
  return patterns;
}

export function mentionedTags(body, known) {
  if (!body || !Array.isArray(known)) return [];
  const hits = [];
  for (const k of known) {
    const tag = typeof k === 'string' ? k : k?.tag;
    if (!tag || hits.some(h => h.tag === tag)) continue;
    const title = typeof k === 'object' && k ? k.title : null;
    const spans = [];
    for (const re of tagAliasPatterns(tag, title)) {
      const g = new RegExp(re.source, 'gi');
      let m;
      while ((m = g.exec(body))) {
        spans.push([m.index, m.index + m[0].length]);
        if (!m[0]) g.lastIndex++;
      }
    }
    if (spans.length) hits.push({ tag, spans });
  }
  // "qualia" inside "qualia bible" is the bible, not the qualia doc: a tag whose
  // every mention lies inside another tag's longer mention is dropped.
  const inside = ([s, e], other) => other.spans.some(([os, oe]) => os <= s && e <= oe && oe - os > e - s);
  return hits
    .filter(h => !h.spans.every(span => hits.some(o => o !== h && inside(span, o))))
    .map(h => h.tag);
}

export function parseReferenceDirectives(messageBody) {
  if (!messageBody) return { refs: [], cleanBody: messageBody };
  const lines = messageBody.split('\n');
  const refs = [];
  const kept = [];
  const scanLimit = Math.min(lines.length, 8);
  const refRe = /^\s*(?:make\s*-?\s*reference|reference|makeref)\s*:?\s+(.+)$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = i < scanLimit ? lines[i].match(refRe) : null;
    if (m) {
      for (const tok of m[1].split(/[,\s/&+]+/)) {
        const tag = tok.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (tag && tag !== 'and' && !refs.includes(tag)) refs.push(tag);
      }
    } else {
      kept.push(lines[i]);
    }
  }
  return { refs, cleanBody: kept.join('\n').trim() };
}


// Image directives (GH#7, grammar v2 — 2026-10-10):
//   MakeImage swarm <desc>            → image for project swarm
//   MakeImage <desc>                  → STANDALONE image (no project)
//   MakeImage swarm again + notes     → iterate on swarm's last image
// AND inline within a doc command message:
//   MakeUpdate swarm
//   makeimage "a logo for the swarm army"
//   (…optional additional update text…)
// parseInlineImage extracts a makeimage directive from anywhere in the first
// 10 lines (quoted or bare prompt, same-line or rest-of-line), returning the
// prompt and the body with the directive removed.
export function parseImageCommand(messageBody) {
  if (!messageBody) return { isImage: false };
  const lines = messageBody.split('\n');
  const first = lines[0].trim();
  const m = first.match(/^make\s*-?\s*(?:image|img|picture)\b\s*(.*)$/i);
  if (!m) return { isImage: false };
  const rest = (m[1] || '').trim();
  const body = lines.slice(1).join('\n').trim();
  // project token = first word IF it looks like a bare tag and more follows,
  // or if it is the only word (then body is the intent)
  const wm = rest.match(/^([a-z0-9]+)\s*(.*)$/i);
  let project = null, after = rest;
  if (wm && /^[a-z0-9]{2,20}$/i.test(wm[1]) && !/^(a|an|the|of|me|my|us)$/i.test(wm[1])) {
    project = wm[1].toLowerCase();
    after = (wm[2] || '').trim();
  }
  const iterate = /^(again|refine|update|iterate)\b/i.test(after);
  if (iterate) after = after.replace(/^(again|refine|update|iterate)\b[:,\s]*/i, '');
  const intent = [after, body].filter(Boolean).join('\n').trim();
  // "MakeImage a sunset over..." → wm[1]='a' rejected above → standalone
  return { isImage: true, project, iterate, intent };
}

// Inline: find `makeimage …` on its own line (or after other directives) and
// pull out the prompt. Quoted prompts win; otherwise rest-of-line + nothing.
export function parseInlineImage(messageBody) {
  if (!messageBody) return { imagePrompt: null, cleanBody: messageBody };
  const lines = messageBody.split('\n');
  const kept = [];
  let imagePrompt = null;
  const scanLimit = Math.min(lines.length, 10);
  for (let i = 0; i < lines.length; i++) {
    if (imagePrompt === null && i < scanLimit && i > 0) {  // not line 0 (that's the doc command)
      const m = lines[i].match(/^\s*make\s*-?\s*(?:image|img|picture)\s*:?\s*(.*)$/i);
      if (m) {
        let p = (m[1] || '').trim();
        const q = p.match(/^["'“”](.+?)["'“”]$/s) || p.match(/^\((.+)\)$/s);
        if (q) p = q[1].trim();
        imagePrompt = p || '';
        continue;
      }
    }
    kept.push(lines[i]);
  }
  return { imagePrompt, cleanBody: kept.join('\n').trim() };
}

