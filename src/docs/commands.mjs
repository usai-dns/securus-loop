// Parse doc commands from inbound messages
// makenew {name} — create a new topic document
// makeupdate {name} — append to an existing topic document

export function parseDocCommand(messageBody) {
  if (!messageBody) return { command: null, docTag: null, cleanBody: messageBody };

  const lines = messageBody.split('\n');
  const firstLine = lines[0].trim().toLowerCase();

  // match: makenew {word} (ignore anything after the topic name, e.g. dates/numbers)
  const newMatch = firstLine.match(/^makenew\s+(\w+)/i);
  if (newMatch) {
    return {
      command: 'makenew',
      docTag: newMatch[1].toLowerCase(),
      cleanBody: lines.slice(1).join('\n').trim(),
    };
  }

  // match: makeupdate {word} (ignore anything after the topic name)
  const updateMatch = firstLine.match(/^makeupdate\s+(\w+)/i);
  if (updateMatch) {
    return {
      command: 'makeupdate',
      docTag: updateMatch[1].toLowerCase(),
      cleanBody: lines.slice(1).join('\n').trim(),
    };
  }

  return { command: null, docTag: null, cleanBody: messageBody };
}

// Build the acknowledgment prefix for the AI response based on the doc command
export function docAcknowledgment(command, docTag) {
  if (!command || !docTag) return '';

  const name = docTag.charAt(0).toUpperCase() + docTag.slice(1);

  if (command === 'makenew') {
    return `I've started a new ${name} document and added your notes and my research/responses to it.\n\n`;
  }
  if (command === 'makeupdate') {
    return `I've updated your ${name} document with these notes and my responses.\n\n`;
  }
  return '';
}
