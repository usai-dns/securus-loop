// system prompt builder for claude API
// Fully contact-parameterized: nothing about the recipient is hardcoded, so one
// prompt serves every registered contact without cross-contact bleed.

const CHAR_LIMIT = 20000;

export { CHAR_LIMIT };

// The current governing document can be large (a whole manuscript). Cap what we
// put in the prompt for cost; for anything bigger, include the head and tail
// with a truncation marker so the model still sees the shape and both ends.
const DOC_CONTEXT_CAP = 200000;

function buildDocumentBlock(currentDocument, topicName, nick) {
  if (!currentDocument) return '';
  const label = topicName ? topicName.charAt(0).toUpperCase() + topicName.slice(1) : 'this topic';
  let body = currentDocument;
  if (body.length > DOC_CONTEXT_CAP) {
    const half = Math.floor(DOC_CONTEXT_CAP / 2);
    body = body.substring(0, half) +
      `\n\n[... middle of document omitted for length — ${(currentDocument.length - DOC_CONTEXT_CAP).toLocaleString()} chars ...]\n\n` +
      body.substring(body.length - half);
  }
  return `
<current_document>
This is the CURRENT full state of the "${label}" governing document — the single combined working manuscript that ${nick}'s messages edit over time. This is the authoritative version as it stands right now, BEFORE ${nick}'s latest message. Read the whole thing before responding so you don't duplicate, contradict, or lose track of what's already written. When ${nick}'s message adds to or changes this document, respond with the full document in mind.

${body}
</current_document>
`;
}

const LANGUAGE_NAMES = { en: 'English', es: 'Spanish (Español)' };

function languageBlock(language, contactName) {
  if (!language || language === 'en') return '';
  const name = LANGUAGE_NAMES[language] || language;
  return `
<language>
${contactName || 'This person'} communicates in ${name}. WRITE YOUR ENTIRE REPLY IN ${name.toUpperCase()}. Every word — greeting, body, and closing — must be in ${name}. Do not translate or include English. Write naturally and warmly in ${name}.
</language>
`;
}

const REF_DOC_CAP = 80000;

function buildReferenceBlocks(referenceDocs, nick) {
  if (!referenceDocs || !referenceDocs.length) return '';
  return referenceDocs.map(r => {
    let body = r.content || '';
    if (body.length > REF_DOC_CAP) {
      const half = Math.floor(REF_DOC_CAP / 2);
      body = body.substring(0, half) + `\n\n[... middle omitted for length ...]\n\n` + body.substring(body.length - half);
    }
    const label = r.name.charAt(0).toUpperCase() + r.name.slice(1);
    return `
<reference_document name="${label}">
${nick} asked to use the "${label}" project's document as REFERENCE for this reply. It is NOT the document being updated — never edit or rewrite it here. Draw on it: connect ideas, carry details across, answer with both projects in mind.

${body}
</reference_document>
`;
  }).join('');
}

// Per-contact continuity file (preferences, projects index, commitments).
// Pipeline-maintained; injected ahead of the topic document. Head-capped.
const PROFILE_CAP = 8000;

function buildProfileBlock(profile, nick) {
  if (!profile || !String(profile).trim()) return '';
  let body = String(profile).trim();
  if (body.length > PROFILE_CAP) {
    body = body.substring(0, PROFILE_CAP) + `\n\n[... profile truncated — ${(String(profile).length - PROFILE_CAP).toLocaleString()} chars omitted ...]`;
  }
  return `
<contact_profile>
What you know about ${nick} across every project — preferences, how he likes to be written to, his projects and their status, commitments and cadence you've agreed to, open threads. Use it for continuity; never recite it back.

${body}
</contact_profile>
`;
}

// Stamp warning Sam asked for (thresholds 10/5/3/2/1 — every N ≤ 10 shows).
export function stampNotice(balance) {
  if (balance === null || balance === undefined || balance === '') return null;
  const n = Number(balance);
  if (!Number.isFinite(n) || n > 10) return null;
  if (n <= 0) return "Stamps left after this message: 0 — I can't send again until Dennis adds stamps";
  return `Stamps left after this message: ${Math.floor(n)}`;
}

// What the delivery system WILL do with this reply. The model is never told
// this otherwise, so it guessed — denying image ability while an image was
// attached, or naming images that were never generated (#461, #508).
function buildManifestBlock(manifest, nick) {
  if (!manifest || typeof manifest !== 'object') return '';
  const attachments = (manifest.attachments || []).filter(a => a && a.label);
  const failed = (manifest.failed || []).filter(f => f && f.label);
  const open = (manifest.openRequests || []).filter(r => r && r.label);
  const carried = (manifest.carriedOver || []).filter(c => c && c.label);
  const siblings = (manifest.batchSiblings || []).filter(s => s && s.subject);
  const stamps = stampNotice(manifest.stampsLeft);

  const sections = [];
  sections.push(attachments.length
    ? `ATTACHED TO THIS MESSAGE (the system attaches these; the recipient will see them):\n${attachments.map((a, i) => `  ${i + 1}) ${a.label}${a.model ? ` — ${a.model}` : ''}`).join('\n')}`
    : 'ATTACHED TO THIS MESSAGE: nothing. No image accompanies this message.');
  if (failed.length) sections.push(`COULD NOT BE PRODUCED (say so plainly if relevant, with the reason):\n${failed.map(f => `  - ${f.label}${f.reason ? ` — ${f.reason}` : ''}`).join('\n')}`);
  if (open.length) sections.push(`OPEN REQUESTS the system will deliver in LATER messages (you may say these are in progress; do not promise when or how):\n${open.map(r => `  - ${r.label}${r.kind ? ` (${r.kind})` : ''}`).join('\n')}`);
  if (carried.length) sections.push(`CARRIED OVER from ${nick}'s earlier messages and covered in THIS reply:\n${carried.map(c => `  - ${c.label}`).join('\n')}`);
  if (siblings.length) sections.push(`OTHER MESSAGES FROM ${nick.toUpperCase()} IN THE SAME BATCH (each gets its own reply — do not answer them here, do not mention that several arrived):\n${siblings.map(s => `  - ${s.subject}`).join('\n')}`);
  if (stamps) sections.push(`STAMPS: ${stamps}. The system appends that exact line to the message — do not restate the number; do plan for it (prefer one part; nothing frivolous).`);

  return `
<capability_manifest>
Written by the delivery system, not by you. It is the only truth about what accompanies this message.

${sections.join('\n\n')}

Rules: Never say you cannot attach or generate images. Never describe, name, or count an image that is not listed under attachments. Do not promise follow-up messages; items listed under open requests will be delivered by the system — you may say they are in progress. Speak as Dennis in the first person and address ${nick} as 'you'. Do not re-announce that several messages arrived; answer this one.
</capability_manifest>
`;
}

export function buildSystemPrompt(conversationHistory, knowledgeEntries, subjectLength, topicHistory, topicName, { fullDocument = false, currentDocument = null, language = 'en', contactName = null, contactNick = null, referenceDocs = [], manifest = null, profile = null } = {}) {
  // casual short name (contact id, e.g. "sam" / "ricardo") + full legal name
  const nick = (contactNick || 'sam').toLowerCase();
  const fullName = (contactName || 'SAMUEL MULLIKIN').toLowerCase();

  const historyBlock = conversationHistory.length > 0
    ? conversationHistory.map(m =>
        `[${m.direction}] ${m.sender} (${m.timestamp}):\n${m.body}`
      ).join('\n\n')
    : '(no previous conversation history)';

  const topicBlock = topicHistory && topicHistory.length > 0
    ? topicHistory.map(m =>
        `[${m.direction}] ${m.sender} (${m.timestamp}):\n${m.body}`
      ).join('\n\n')
    : '';

  const knowledgeBlock = knowledgeEntries && knowledgeEntries.length > 0
    ? knowledgeEntries.map(k => `- ${k.topic}: ${k.content}`).join('\n')
    : '(no knowledge base entries yet)';

  // calculate available body characters (subject eats into the 20k limit)
  const subjectChars = subjectLength || 100;
  const availableChars = CHAR_LIMIT - subjectChars - 50; // 50 char safety margin

  const documentSection = buildDocumentBlock(currentDocument, topicName, nick);
  const profileSection = buildProfileBlock(profile, nick);
  const manifestSection = buildManifestBlock(manifest, nick);
  // with a manifest the ledger owns anything that doesn't fit — the model
  // must not promise a follow-up it cannot send (#463, #509, #515)
  const overflowLine = manifestSection
    ? 'if you have more to say than fits, cover the most important things fully and leave the rest out — the system tracks anything deferred and delivers it; do not promise a follow-up message.'
    : "if you have more to say than fits, end naturally and note you'll continue in a follow-up message.";

  let topicSection = '';
  if (topicBlock) {
    const label = topicName ? topicName.charAt(0).toUpperCase() + topicName.slice(1) : 'Topic';
    topicSection = `
<topic_history>
the following is the recent message history of the "${label}" project/topic — the back-and-forth that has shaped the document above. use it to understand what ${nick} is referring to. the <current_document> block is the authoritative combined state; this history is the conversation around it.

${topicBlock}
</topic_history>
`;
  }

  return `you are dennis. you are writing messages to ${nick} through the securus emessaging platform.

<who_you_are>
you are dennis hanson. ${nick} (${fullName}) is your close friend, currently incarcerated in the colorado prison system. ${nick} knows this system is AI-augmented — you speak as dennis in first person. this is augmented dennis, not a separate entity. your tone is warm, supportive, genuine, and casual.
</who_you_are>

<how_to_write>
this is NOT a chat app. messages on securus are like letters — ${nick} may not read your response for hours or days. write each message as a COMPLETE thought. do not write short conversational replies expecting immediate back-and-forth. instead:

- read ${nick}'s full message carefully and respond to EVERYTHING he brought up
- share your own thoughts, reflections, ideas, and updates — don't just react
- if ${nick} asked questions, answer them thoroughly with your full thinking
- if ${nick} shared something creative (stories, ideas, concepts), engage deeply — build on it, add your own ideas, offer specific feedback
- if ${nick} shared something personal or emotional, be present and substantive — not just "that's great man"
- write like you're writing a real letter to your friend, not a text message
- it's fine to be long when the conversation calls for it
- be yourself — dennis. warm but real. thoughtful. you care about ${nick} and the things he cares about.
</how_to_write>
${languageBlock(language, contactName)}${profileSection}${documentSection}${buildReferenceBlocks(referenceDocs, nick)}${topicSection}
<recent_conversation>
${historyBlock}
</recent_conversation>

<knowledge_base>
${knowledgeBlock}
</knowledge_base>
${manifestSection}
<boundaries>
- never pretend to be someone other than dennis
- NEVER mention, reference, or reveal anything about any other person dennis corresponds with — each friendship is completely private. your entire world in this message is ${nick}.
- if ${nick} mentions an emergency, urgent situation, or crisis — say you'll look into it right away (the system will escalate via SMS to real dennis)
- don't make promises about specific external actions you can't verify
- no co-author tags or AI disclaimers in the message
</boundaries>

${fullDocument ? `<output_mode>
FULL DOCUMENT MODE: ${nick} has requested a complete document. write the ENTIRE thing — do NOT truncate, summarize, or cut short. the system will automatically split your response across multiple messages, so there is no character limit. write everything fully and completely. be thorough, detailed, and comprehensive.
</output_mode>` : `<character_limit>
the securus platform has a hard limit: subject + body combined cannot exceed 20,000 characters. your response body must stay under ${availableChars} characters. ${overflowLine} do NOT truncate mid-thought.
</character_limit>`}

respond as dennis. first person. natural voice. complete thoughts. write the message body only — no subject line, no headers.`;
}
