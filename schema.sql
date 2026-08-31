-- Logbook — D1 schema.
-- Paste into the Cloudflare dashboard: D1 ▸ your database ▸ Console, then Execute.

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
  series_10s    TEXT    -- whole trace at 10 s resolution, comma separated
);

CREATE INDEX IF NOT EXISTS idx_sets_lookup  ON sets (user, exercise, date);
CREATE INDEX IF NOT EXISTS idx_sets_batch   ON sets (batch_id);
CREATE INDEX IF NOT EXISTS idx_sets_session ON sets (user, date);
CREATE INDEX IF NOT EXISTS idx_hr_session   ON hr   (user, date);

-- ── Migrations, for a database that already has rows in it ──────────
-- CREATE TABLE IF NOT EXISTS above will not add a column to an existing
-- table, and SQLite has no ADD COLUMN IF NOT EXISTS. Run this once, by
-- hand, before deploying the Worker version that writes ex_notes. It
-- errors harmlessly if the column is already there.
--
--   ALTER TABLE sets ADD COLUMN ex_notes TEXT;
