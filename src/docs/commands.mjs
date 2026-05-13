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
