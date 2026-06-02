-- Voice call tracking table (added to shared securus-agent-db)
CREATE TABLE IF NOT EXISTS voice_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  call_sid TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_seconds INTEGER,
  transcript TEXT,
  summary TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
