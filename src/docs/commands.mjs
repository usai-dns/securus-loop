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


// Parse MakeImage — first line like:
//   MakeImage Swarm            make image swarm
//   MakeImg monday             MakeImage Swarm again   (iteration)
// Body below the first line = Sam's description/intent for the image.
// Returns { isImage, project, iterate, intent } (isImage false when absent).
export function parseImageCommand(messageBody) {
  if (!messageBody) return { isImage: false };
  const lines = messageBody.split('\n');
  const first = lines[0].trim();
  const m = first.match(/^make\s*-?\s*(?:image|img)\s+([a-z0-9]+)\s*(again|refine|update|iterate)?\s*$/i)
         || first.match(/^make\s*-?\s*(?:image|img)\s+([a-z0-9]+)\b(.*)$/i);
  if (!m) return { isImage: false };
  const project = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  const iterate = /^(again|refine|update|iterate)$/i.test(rest);
  const intent = [iterate ? '' : rest, ...lines.slice(1)].join('\n').trim();
  return { isImage: true, project, iterate, intent };
}
