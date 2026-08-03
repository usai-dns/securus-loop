-- contacts: the multi-tenant boundary. Each inmate is one contact; all their
-- messages/documents/queue are scoped by contact_id so nothing ever mixes.
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,           -- short key, e.g. 'sam', 'ricardo'
  securus_id TEXT,               -- Securus compose contact id (dropdown value)
  name TEXT,                     -- full name as shown in Securus
  doc_number TEXT,               -- DOC / inmate number (for physical mail)
  language TEXT DEFAULT 'en',    -- reply language: 'en' | 'es'
  match_names TEXT,              -- comma-separated tokens to attribute inbox senders
  persona TEXT DEFAULT 'Dennis', -- who the AI speaks as to this contact
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO contacts (id, securus_id, name, doc_number, language, match_names, persona) VALUES
  ('sam', '65651103', 'SAMUEL MULLIKIN', NULL, 'en', 'SAMUEL,MULLIKIN', 'Dennis'),
  ('ricardo', '67887839', 'RICARDO CHALCHISEVILLA', '156419', 'es', 'RICARDO,CHALCHISEVILLA', 'Dennis');

-- conversation log: every message in and out
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  contact_id TEXT NOT NULL DEFAULT 'sam',
  direction TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  read_at TEXT,
  responded_at TEXT,
  response_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  doc_tag TEXT DEFAULT NULL
);

-- knowledge base: extracted context that grows over time
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  source_message_id INTEGER,
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_message_id) REFERENCES messages(id)
);

-- system state: operational metadata
CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- initial state entries
INSERT OR IGNORE INTO system_state (key, value) VALUES
  ('last_check', ''),
  ('last_message_id', ''),
  ('total_checks', '0'),
  ('total_messages_sent', '0'),
  ('last_error', '');

-- outbound send queue: persistent queue for multi-part outbound messages
CREATE TABLE IF NOT EXISTS send_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbound_id INTEGER,
  series_id INTEGER,
  part_num INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  doc_tag TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT,
  outbound_msg_id INTEGER,
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  last_attempt_at TEXT,
  contact_id TEXT NOT NULL DEFAULT 'sam',
  securus_id TEXT
);

-- governing documents: one living body per topic, edited in place by the AI as
-- Sam sends makenew/makeupdate. This is the "combined final document" — distinct
-- from the message stream that edits it.
-- keyed by (contact_id, tag) so each contact has an independent document per tag
CREATE TABLE IF NOT EXISTS documents (
  contact_id TEXT NOT NULL DEFAULT 'sam',
  tag TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  source_count INTEGER DEFAULT 0,       -- how many inbound edits fed this doc
  last_message_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (contact_id, tag)
);

-- immutable snapshot per document edit — the doc's own version history
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL DEFAULT 'sam',
  tag TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  change_note TEXT,
  message_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(contact_id, tag, version)
);

-- inbound series: tracks multi-part inbound messages ("message 1/6", "message 2/6"...)
CREATE TABLE IF NOT EXISTS inbound_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT NOT NULL DEFAULT 'sam',
  series_key TEXT NOT NULL UNIQUE,
  total_parts INTEGER NOT NULL,
  received_parts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'collecting',
  doc_tag TEXT,
  doc_command TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  processed_at TEXT
);

-- links individual inbound messages to their series
CREATE TABLE IF NOT EXISTS inbound_series_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL,
  part_num INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (series_id) REFERENCES inbound_series(id),
  FOREIGN KEY (message_id) REFERENCES messages(id),
  UNIQUE(series_id, part_num)
);

-- indexes
CREATE INDEX IF NOT EXISTS idx_messages_external_id ON messages(external_id);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge(topic);
CREATE INDEX IF NOT EXISTS idx_messages_doc_tag ON messages(doc_tag);
CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue(status);
CREATE INDEX IF NOT EXISTS idx_send_queue_inbound ON send_queue(inbound_id);
CREATE INDEX IF NOT EXISTS idx_inbound_series_status ON inbound_series(status);
CREATE INDEX IF NOT EXISTS idx_series_parts_series ON inbound_series_parts(series_id);
CREATE INDEX IF NOT EXISTS idx_doc_versions_tag ON document_versions(tag);
