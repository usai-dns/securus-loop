#!/usr/bin/env node
// one-shot script: clean sam.md and output formatted starkiller import content

import { readFileSync } from 'fs';

const raw = readFileSync('/root/.claude/uploads/a03ab319-992c-4513-b2b0-29b6ca914dd7/e23059e9-sam.md', 'utf8');

const lines = raw.split('\n');

// parse into exchanges — remove duplicates, metadata, navigation artifacts
const exchanges = [];
let current = null;
let lastLine = '';

for (const rawLine of lines) {
  const line = rawLine.trimEnd();

  // skip empty lines at start of content blocks, but keep them between paragraphs
  if (!line && !current) continue;

  // skip metadata/navigation artifacts
  if (line.match(/^\[sam\]\(https:\/\/claude\.ai/)) continue;
  if (line.match(/^\[Claude is AI/)) continue;
  if (line === '/' || line === 'Show more') continue;
  if (line.match(/^##\s*$/)) continue;

  // skip exact duplicate of previous line (raw export has lots of these)
  if (line === lastLine && line.length > 3) continue;

  // detect speaker transitions
  const samMatch = line.match(/^You said:\s*(.*)/);
  const claudeMatch = line.match(/^Claude responded:\s*(.*)/);
  const dateMatch = line.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/);

  if (samMatch) {
    if (current) exchanges.push(current);
    current = { speaker: 'Sam', lines: [] };
    if (samMatch[1].trim()) current.lines.push(samMatch[1].trim());
    lastLine = line;
    continue;
  }

  if (claudeMatch) {
    if (current) exchanges.push(current);
    current = { speaker: 'Claude (Dennis)', lines: [] };
    if (claudeMatch[1].trim()) current.lines.push(claudeMatch[1].trim());
    lastLine = line;
    continue;
  }

  // skip date lines and tracker summary lines (short italic-style lines from Claude)
  if (dateMatch && line.length < 20) {
    lastLine = line;
    continue;
  }

  // skip Claude tracker summary lines (appear after "Claude responded:" — short activity summaries)
  if (current && current.speaker === 'Claude (Dennis)') {
    const lower = line.toLowerCase();
    if (lower.startsWith('tracked ') || lower.startsWith('analyzed ') || lower.startsWith('disambiguated ') ||
        lower.startsWith('processed ') || lower.startsWith('recorded ') || lower.startsWith('noted ') ||
        lower.startsWith('mapped ') || lower.startsWith('acknowledged ') || lower.startsWith('integrated ')) {
      lastLine = line;
      continue;
    }
  }

  if (current) {
    current.lines.push(line);
  }

  lastLine = line;
}
if (current) exchanges.push(current);

// deduplicate paragraphs within each exchange
for (const ex of exchanges) {
  const paras = ex.lines.join('\n').split('\n\n');
  const seen = new Set();
  const deduped = [];
  for (const p of paras) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  ex.body = deduped.join('\n\n');
}

// build formatted markdown
let md = `# Starkiller — Sam's Claude.ai Project Conversations (Import)

> These are Sam's conversations with Claude about the Starkiller project, imported from his Claude.ai project workspace. This represents Sam's primary worldbuilding and creative development work.

---

`;

let num = 0;
for (const ex of exchanges) {
  if (!ex.body || ex.body.length < 10) continue;
  num++;

  md += `### ${ex.speaker}\n\n${ex.body}\n\n---\n\n`;
}

md += `\n*Imported: ${new Date().toISOString()} | ${num} exchanges | ${md.length} characters*\n`;

console.log(JSON.stringify({ length: md.length, exchanges: num }));

// write cleaned output to temp file for inspection
import { writeFileSync } from 'fs';
writeFileSync('/tmp/starkiller-import-cleaned.md', md);
console.error(`wrote ${md.length} chars to /tmp/starkiller-import-cleaned.md`);
