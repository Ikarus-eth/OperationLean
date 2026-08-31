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
  notes     TEXT,
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
