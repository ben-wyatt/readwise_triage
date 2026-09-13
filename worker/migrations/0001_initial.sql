CREATE TABLE IF NOT EXISTS triage_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS triage_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  site_name TEXT NOT NULL,
  author TEXT,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  published_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  word_count INTEGER,
  reading_progress REAL NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '{}',
  summary TEXT,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS triage_documents_active_feed
  ON triage_documents(location, category);

CREATE TABLE IF NOT EXISTS triage_runs (
  run_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  documents_fetched INTEGER NOT NULL DEFAULT 0,
  candidates_scored INTEGER NOT NULL DEFAULT 0,
  documents_promoted INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS triage_decisions (
  run_key TEXT NOT NULL REFERENCES triage_runs(run_key),
  document_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  score REAL NOT NULL,
  bucket_rank INTEGER NOT NULL,
  promoted INTEGER NOT NULL CHECK (promoted IN (0, 1)),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (run_key, document_id)
);

CREATE INDEX IF NOT EXISTS triage_decisions_document
  ON triage_decisions(document_id, decided_at DESC);
