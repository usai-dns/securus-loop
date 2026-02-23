-- conversation log: every message in and out
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  direction TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  read_at TEXT,
  responded_at TEXT,
  response_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
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

-- indexes
CREATE INDEX IF NOT EXISTS idx_messages_external_id ON messages(external_id);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge(topic);
