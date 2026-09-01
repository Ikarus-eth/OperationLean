-- Logbook — D1 schema.
--
-- You do not need to run this. The Worker creates these tables and adds any
-- missing column on its first request after a deploy, so an empty database
-- becomes a working one on its own. This file is here to read.
--
-- To add a column: put it in SCHEMA_COLUMNS in worker.js and here, and deploy.
-- That is the whole migration process.

CREATE TABLE IF NOT EXISTS sets (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT,      -- when the row was written, ISO
  date      TEXT,      -- session date, YYYY-MM-DD
  user      TEXT,
  session   TEXT,      -- 'Lower 1', 'Upper A', …
  exercise  TEXT,
  set_no    INTEGER,
  weight    REAL,
  reps      REAL,
  rir       REAL,
  notes     TEXT,      -- session note, the same on every row of the session
  ex_notes  TEXT,      -- comment on this exercise, the same on its own rows
  batch_id  TEXT,      -- stops an offline retry writing twice
  set_ts    TEXT,      -- when the set was ticked, ISO
  hr_avg    REAL,
  hr_peak   REAL
);

CREATE TABLE IF NOT EXISTS hr (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT,
  date          TEXT,
  user          TEXT,
  session       TEXT,
  source        TEXT,   -- the exported filename
  start         TEXT,
  finish        TEXT,
  duration_min  REAL,
  avg_hr        REAL,
  max_hr        REAL,
  pct_max       REAL,
  min_above_80  REAL,
  z1 REAL, z2 REAL, z3 REAL, z4 REAL, z5 REAL,
  samples       INTEGER,
  series_10s    TEXT,   -- whole trace at 10 s resolution, comma separated
  workout_id    TEXT,   -- the watch's own id for the workout, when it sends one
  workout_type  TEXT    -- 'Traditional Strength Training', 'Surfing', …
);

CREATE INDEX IF NOT EXISTS idx_sets_lookup  ON sets (user, exercise, date);
CREATE INDEX IF NOT EXISTS idx_sets_batch   ON sets (batch_id);
CREATE INDEX IF NOT EXISTS idx_sets_session ON sets (user, date);
CREATE INDEX IF NOT EXISTS idx_hr_session   ON hr   (user, date);
CREATE INDEX IF NOT EXISTS idx_hr_dedupe    ON hr   (user, start);

-- ── Migrations ──────────────────────────────────────────────────────
-- Handled by ensureSchema() in worker.js. It runs each statement on its
-- own, because a batch is one transaction and one "duplicate column name"
-- would abort the rest — which is what went wrong doing this by hand.
