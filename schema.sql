-- Chorus D1 Schema
-- Bridging-based community notes aggregator

-- Indexed notes with computed scores
CREATE TABLE IF NOT EXISTS notes (
  uri TEXT PRIMARY KEY,              -- at://did/site.filae.chorus.note/tid
  did TEXT NOT NULL,                 -- author DID
  subject_uri TEXT NOT NULL,         -- what's being annotated
  body TEXT NOT NULL,
  sources TEXT,                      -- JSON array of source URLs
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,

  -- Computed bridging scores (updated by algorithm runs)
  rating_count INTEGER DEFAULT 0,
  intercept REAL DEFAULT 0,          -- i_n (note intercept/helpfulness)
  factor REAL DEFAULT 0,             -- f_n (note factor/perspective)
  status TEXT DEFAULT 'pending',     -- pending, certified, needs_more, rejected
  status_updated_at TEXT,

  -- Simple aggregate (for comparison/debugging)
  avg_rating REAL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes(subject_uri);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_did ON notes(did);

-- Individual ratings
CREATE TABLE IF NOT EXISTS ratings (
  uri TEXT PRIMARY KEY,              -- at://did/site.filae.chorus.rating/tid
  did TEXT NOT NULL,                 -- rater DID
  note_uri TEXT NOT NULL,            -- note being rated
  helpful REAL NOT NULL,             -- 1.0, 0.5, or 0.0
  tags TEXT,                         -- JSON array
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE(did, note_uri)              -- one rating per user per note
);

CREATE INDEX IF NOT EXISTS idx_ratings_note ON ratings(note_uri);
CREATE INDEX IF NOT EXISTS idx_ratings_did ON ratings(did);

-- Rater profiles (learned from rating patterns)
CREATE TABLE IF NOT EXISTS raters (
  did TEXT PRIMARY KEY,
  factor REAL DEFAULT 0,             -- f_u (user's perspective factor)
  intercept REAL DEFAULT 0,          -- i_u (user's rating bias)
  rating_count INTEGER DEFAULT 0,
  last_updated_at TEXT
);

-- Algorithm run history (audit trail)
CREATE TABLE IF NOT EXISTS algorithm_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  notes_processed INTEGER,
  ratings_processed INTEGER,
  notes_certified INTEGER,
  notes_rejected INTEGER,
  iterations INTEGER,
  final_loss REAL,
  status TEXT DEFAULT 'running'      -- running, completed, failed
);
