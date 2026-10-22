/**
 * Logbook — Cloudflare Worker backend.
 *
 * Replaces the Google Apps Script. Speaks the same API, so index.html needs
 * no code change: only the ENDPOINT value.
 *
 *   GET  /                                   health check                (open)
 *   GET  ?action=last&user=ikarus            last session per exercise   (open)
 *        [&date=&session=]                   ...not counting that session  
 *   GET  ?action=day&user=&date=             what the watch sent that day (open)
 *   GET  ?action=csv&table=sets              whole log as CSV            (open)
 *   GET  ?action=order&user=ikarus           exercise order per session  (open)
 *   POST { secret, orders:[…] }              remember an exercise order  (secret)
 *   POST { secret, sync, user, date, session, rows[], hr }   replace a day's
 *                                            session, sent continuously (secret)
 *   POST { secret, batchId, rows[], hr }     append a session, legacy (secret)
 *   POST ?user=ikarus  {data:{workouts}}     Health Auto Export push  (secret)
 *   POST ?user=ikarus&day=…  112,118,125       a bare list of readings,
 *                                            for an iOS Shortcut
 *   GET|POST|PUT ?action=hevy&path=/v1/…     pass-through to Hevy's API with
 *                                            the caller's own key in x-hevy-key,
 *                                            for hevy-routines.html
 *   GET  ?action=hevy-key&user=&key=&secret=  store a person's Hevy key (secret)
 *   GET  ?action=hevy-sync&user=&secret=      write routines.json into that
 *                                            person's Hevy as routines (secret)
 *   GET  ?action=hevy-pull&user=&secret=      read new Hevy workouts into the log
 *                                            (secret; also every 30 min by cron)
 *   GET  ?action=log&user=&from=&to=          the log as compact text, one line
 *                                            per exercise, with heart rate (open)
 *   GET  ?action=pushlog                      the last 30 phone pushes: when,
 *                                            whose, how big, what came back (open)
 *
 * Reads are deliberately open: the log is training data and nothing here can
 * reach any other account. Writes still need the secret, so nobody can drop
 * junk rows in and corrupt the carried-over values the app reads back.
 *
 * The phone pushes heart rate on its own schedule, so per-set attribution is
 * done here rather than in the browser. Every write re-attributes that day,
 * which makes the arrival order irrelevant.
 *
 * Set up in the Cloudflare dashboard:
 *   DB              — D1 database, added under Settings ▸ Bindings
 *   LOGBOOK_SECRET  — added under Settings ▸ Variables and Secrets, type Secret.
 *                     A Secrets Store binding of the same name also works.
 *
 * Run the migrations at the bottom of schema.sql BEFORE deploying this, or
 * every write fails on a missing column.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-hevy-key',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });

/** '' for blank, a number where possible, otherwise the raw string. */
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : String(v);
}
const str = v => (v === null || v === undefined) ? '' : String(v);

/* ── heart rate ───────────────────────────────────────────────────────
 * These three numbers are also in index.html and must be changed in both
 * places together. The Worker needs them because heart rate can now arrive
 * from the phone hours after the sets, with no browser involved.
 */
/* Advertised on the health check so the app can tell whether the Worker in
   front of it understands what it is about to send. Without this an older
   Worker takes a sync payload, ignores the sync flag, sees rows and appends
   them — once a second, with no batch id to deduplicate on. Bump VERSION when
   the wire format changes; add to FEATURES when a new call is added. */
const VERSION  = '2026-10-22a';
const FEATURES = ['sync', 'day', 'watch-push', 'self-migrate', 'assist-reps', 'last-scoped', 'order', 'hevy', 'hevy-sync', 'hevy-pull', 'log'];

const MAX_HR = { ikarus: 182, johanna: 185 };
const SET_WINDOW_S = 90;      // seconds before a tick that count as "the set"
const MIN_WORKOUT_MIN = 10;   // shorter workouts are ignored, so a walk to the shop is not a row

/** Health Auto Export sends "2026-08-31 09:00:00 +0800", which Date.parse
 *  handles inconsistently across engines. Normalise it first. */
function parseHRDate(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})?$/);
  if (m) return Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}${m[3]}:${m[4] || '00'}`);
  return Date.parse(s.replace(' ', 'T'));
}

/** The calendar day at the watch, taken from the offset in the string rather
 *  than from the Worker's clock, which is UTC and in the wrong place. */
function localDayOf(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** One bucket per entry. Health Auto Export gives Min/Avg/Max per grouping
 *  interval, so the average and the peak come from different fields. */
function samplesOf(workout) {
  const out = [];
  for (const p of (workout.heartRateData || [])) {
    const t = parseHRDate(p.date);
    const avg  = Number(p.Avg ?? p.avg ?? p.qty ?? p.Max ?? p.max);
    const peak = Number(p.Max ?? p.max ?? p.Avg ?? p.avg ?? p.qty);
    if (!Number.isFinite(t) || !Number.isFinite(avg)) continue;
    if (avg <= 20 || avg >= 260) continue;
    out.push({ t, hr: avg, peak: Number.isFinite(peak) ? peak : avg });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** A raw time window has quiet minutes either side of the session — sitting in
 *  the car, walking to the rack. Keep the last stretch that looks like effort,
 *  so a two-hour window and a fifty-minute session give the same row.
 *
 *  Only for hand-rolled pushes. A workout from Health Auto Export is already
 *  bounded by the watch and must be left exactly as it came. */
function trimToEffort(s, maxhr) {
  if (s.length < 12) return s;
  const floor = Math.max(100, 0.55 * maxhr);
  const COOL_RUN = 60;             // easy readings in a row that end a session
  const COOL_GAP = 15 * 60000;     // or a real gap, when the stamps are real

  let end = -1;
  for (let i = s.length - 1; i >= 0; i--) if (s[i].peak >= floor) { end = i; break; }
  if (end < 0) return s;                            // an easy session; keep it all

  /* Walk back from the last hard reading. Counting readings rather than
     minutes is the point: a client that sends values without timestamps has
     them laid back out evenly, which squashes four quiet hours between the
     sauna and the gym into a few apparent minutes. The count survives that. */
  let start = end, cool = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (s[i + 1].t - s[i].t > COOL_GAP) break;
    if (s[i].peak < floor) { if (++cool >= COOL_RUN) break; }
    else { cool = 0; start = i; }
  }

  const pad = 120000;                               // two minutes either side
  const out = s.filter(p => p.t >= s[start].t - pad && p.t <= s[end].t + pad);
  return out.length >= 12 ? out : s;
}

/** Same shape the browser produces, so both paths fill the hr table alike. */
function summariseHR(s, maxhr) {
  if (!s.length) return null;
  const bounds = [0.60, 0.70, 0.80, 0.90].map(f => f * maxhr);
  const zone = hr => hr < bounds[0] ? 0 : hr < bounds[1] ? 1 : hr < bounds[2] ? 2 : hr < bounds[3] ? 3 : 4;

  let sum = 0, total = 0, peak = 0, above80 = 0;
  const zsec = [0, 0, 0, 0, 0];
  for (let i = 0; i < s.length; i++) {
    const dt = i < s.length - 1 ? Math.min((s[i + 1].t - s[i].t) / 1000, 30) : 1;
    sum += s[i].hr * dt; total += dt;
    zsec[zone(s[i].hr)] += dt;
    if (s[i].hr >= bounds[2]) above80 += dt;
    if (s[i].peak > peak) peak = s[i].peak;
  }

  const start = s[0].t, series = [];
  s.forEach(p => {
    const b = Math.floor((p.t - start) / 10000);
    series[b] = Math.max(series[b] || 0, p.peak);
  });
  for (let i = 0; i < series.length; i++) if (!series[i]) series[i] = '';

  return {
    start, end: s[s.length - 1].t,
    duration_min: Math.round((s[s.length - 1].t - s[0].t) / 60000),
    avg_hr: Math.round(sum / Math.max(total, 1)),
    max_hr: peak,
    pct_max: Math.round(peak / maxhr * 100),
    min_above_80: Math.round(above80 / 60),
    z: zsec.map(v => Math.round(v / 60)),
    samples: s.length,
    series_10s: series.join(','),
  };
}

/** Peak and mean in the window ending when a set was ticked, read back out of
 *  series_10s. Ten-second buckets hold the peak, so the peak is exact and the
 *  mean is a mean of nine bucket peaks — a little high, but the same method
 *  whichever way the trace arrived, which matters more than the last bpm. */
function attributeSet(hrRow, tickMs) {
  const t0 = parseHRDate(hrRow.start);
  if (!Number.isFinite(t0)) return null;
  const vals = String(hrRow.series_10s || '').split(',');
  const from = tickMs - SET_WINDOW_S * 1000;
  let peak = 0, sum = 0, n = 0;
  for (let i = 0; i < vals.length; i++) {
    const t = t0 + i * 10000;
    if (t + 10000 < from || t > tickMs) continue;
    const v = Number(vals[i]);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (v > peak) peak = v;
    sum += v; n++;
  }
  return n ? { peak, avg: Math.round(sum / n) } : null;
}

/** Fill hr_avg and hr_peak on every ticked set of a day that falls inside a
 *  workout. Runs after either half is written, so the order they arrive in
 *  stops mattering: sets first and heart rate later works, and so does the
 *  reverse. Cheap enough to just redo the whole day each time. */
async function attributeDay(env, user, date) {
  if (!user || !date) return 0;
  const hrRows = (await env.DB.prepare(
    'SELECT start, finish, series_10s FROM hr WHERE user = ?1 AND date = ?2'
  ).bind(user, date).all()).results || [];
  if (!hrRows.length) return 0;

  const sets = (await env.DB.prepare(
    "SELECT id, set_ts FROM sets WHERE user = ?1 AND date = ?2 AND set_ts IS NOT NULL AND set_ts != ''"
  ).bind(user, date).all()).results || [];
  if (!sets.length) return 0;

  const upd = env.DB.prepare('UPDATE sets SET hr_avg = ?, hr_peak = ? WHERE id = ?');
  const stmts = [];
  for (const s of sets) {
    const t = Date.parse(s.set_ts);
    if (!Number.isFinite(t)) continue;
    let best = null;
    for (const h of hrRows) {
      const a = parseHRDate(h.start), b = parseHRDate(h.finish);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (t < a - SET_WINDOW_S * 1000 || t > b + 60000) continue;
      const r = attributeSet(h, t);
      if (r && (!best || r.peak > best.peak)) best = r;
    }
    if (best) stmts.push(upd.bind(best.avg, best.peak, s.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** Take a Health Auto Export payload and write one hr row per workout.
 *  Idempotent on (user, start): the app re-sends overlapping windows on every
 *  run and splits large exports across several requests. */
async function ingestWorkouts(env, user, payload) {
  const maxhr = MAX_HR[user] || 180;
  const found = [];
  (function walk(node) {                              // shape has moved between versions
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (Array.isArray(node.workouts)) found.push(...node.workouts);
    Object.values(node).forEach(walk);
  })(payload);

  const now = new Date().toISOString();
  let written = 0, skipped = 0;
  const days = new Set();

  for (const w of found) {
    const s = w.trim ? trimToEffort(samplesOf(w), maxhr) : samplesOf(w);
    const sum = summariseHR(s, maxhr);
    if (!sum) { skipped++; continue; }
    if (sum.duration_min < MIN_WORKOUT_MIN) { skipped++; continue; }

    const date = localDayOf(w.day) || localDayOf(w.start) || localDayOf(new Date(sum.start).toISOString());
    const startIso = new Date(sum.start).toISOString();
    const endIso = new Date(sum.end).toISOString();

    // The session name is only known once the sets for that day are in.
    const known = await env.DB.prepare(
      "SELECT session FROM sets WHERE user = ?1 AND date = ?2 AND session != 'Daily' LIMIT 1"
    ).bind(user, date).first();

    const dup = await env.DB.prepare(
      'SELECT id FROM hr WHERE user = ?1 AND start = ?2 LIMIT 1'
    ).bind(user, startIso).first();

    const cols = [
      now, date, user, known ? str(known.session) : '', 'watch:' + str(w.name || 'Workout'),
      startIso, endIso, sum.duration_min, sum.avg_hr, sum.max_hr, sum.pct_max, sum.min_above_80,
      sum.z[0], sum.z[1], sum.z[2], sum.z[3], sum.z[4], sum.samples, sum.series_10s,
      str(w.id || ''), str(w.name || ''),
    ];

    if (dup) {
      await env.DB.prepare(`
        UPDATE hr SET ts=?, date=?, user=?, session=?, source=?, start=?, finish=?,
          duration_min=?, avg_hr=?, max_hr=?, pct_max=?, min_above_80=?,
          z1=?, z2=?, z3=?, z4=?, z5=?, samples=?, series_10s=?, workout_id=?, workout_type=?
        WHERE id=?`).bind(...cols, dup.id).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO hr (ts,date,user,session,source,start,finish,duration_min,avg_hr,max_hr,
          pct_max,min_above_80,z1,z2,z3,z4,z5,samples,series_10s,workout_id,workout_type)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...cols).run();
    }
    written++;
    days.add(date);
  }

  let attributed = 0;
  for (const d of days) attributed += await attributeDay(env, user, d);
  return { written, skipped, seen: found.length, attributed };
}

/** Any hand-rolled client — an iOS Shortcut, curl, a watch app — can send this
 *  much simpler shape instead of the Health Auto Export one:
 *
 *    { "name": "Strength", "day": "2026-09-01",
 *      "start": "2026-09-01 09:00:00 +0800", "end": "2026-09-01 09:47:00 +0800",
 *      "values": "112,118,125,…" }
 *
 *  Everything except "values" is optional, because every field left out is one
 *  more action to build in Shortcuts. With no "end" the run is treated as
 *  having just finished; with no "start" the values are laid back from there at
 *  "step_s" seconds apart, five by default, which is what the watch records
 *  during a workout. "times" overrides all of it when exact stamps are handy.
 *
 *  Send "day", or put the UTC offset in "start" — a 07:00 session in Bali is
 *  the previous calendar day in UTC, and the row would land on the wrong date. */
/** The calendar day at a given UTC offset, for a client that can send its
 *  timezone but not a formatted date.
 *
 *  A plus sign in a query string means a space, so ?tz=+08:00 arrives here as
 *  " 08:00" with the sign eaten. Rather than make anyone type %2B into a phone,
 *  an absent sign is read as plus, which is what someone writing +08:00 meant.
 *  "+0800", "08:00", "8" and "-05:00" all work too. */
function dayInZone(ms, tz) {
  const m = String(tz || '').trim().match(/^([+-]?)(\d{1,2}):?(\d{2})?$/);
  if (!m || !Number.isFinite(ms)) return '';
  const mins = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  if (Math.abs(mins) > 15 * 60) return '';
  return new Date(ms + mins * 60000).toISOString().slice(0, 10);
}

function normaliseSimple(b) {
  let vals = String(b.values ?? '').split(/[,\s]+/).map(v => Number(v)).filter(v => Number.isFinite(v));
  if (!vals.length) return null;
  if (vals.length > 20000) vals = vals.slice(-20000);   // a week of readings, at most

  const step = (Number(b.step_s) > 0 ? Number(b.step_s) : 5) * 1000;
  const times = String(b.times ?? '').split(',').map(s => s.trim()).filter(Boolean);

  let t0 = parseHRDate(b.start);
  let t1 = parseHRDate(b.end);
  const hadStart = Number.isFinite(t0), hadEnd = Number.isFinite(t1);
  if (!Number.isFinite(t1)) t1 = Number.isFinite(t0) ? t0 + (vals.length - 1) * step : Date.now();
  if (!Number.isFinite(t0)) t0 = t1 - (vals.length - 1) * step;
  if (t1 <= t0) t1 = t0 + (vals.length - 1) * step;

  const gap = vals.length > 1 ? (t1 - t0) / (vals.length - 1) : 0;
  const heartRateData = [];
  vals.forEach((v, i) => {
    const t = times.length === vals.length ? parseHRDate(times[i]) : t0 + i * gap;
    if (Number.isFinite(t)) heartRateData.push({ date: new Date(t).toISOString(), Avg: v, Max: v });
  });
  if (!heartRateData.length) return null;

  // Without a day and without an offset in start, the Worker's clock is UTC and
  // in the wrong place, so fall back to the day at the first sample.
  return { data: { workouts: [{
    id: str(b.id || ''), name: str(b.name || 'Workout'),
    // Trim only when the boundaries were guessed. Given both ends explicitly,
    // the caller knows where the session was and is not to be second-guessed.
    trim: String(b.trim ?? '') === 'yes' ||
          (String(b.trim ?? '') !== 'no' && !(hadStart && hadEnd)),
    day: str(b.day || '') || dayInZone(t1, b.tz),
    start: b.start || heartRateData[0].date,
    end: b.end || heartRateData[heartRateData.length - 1].date,
    heartRateData,
  }] } };
}

/* ── schema ───────────────────────────────────────────────────────────
 * The Worker owns its schema. Deploying a version that wrote a new column
 * used to mean remembering to run an ALTER in the D1 console first, and
 * forgetting meant every write failed. Now it checks on its first request
 * and adds whatever is missing.
 *
 * Each statement runs on its own rather than in a batch. A batch is one
 * transaction, so a single "duplicate column" aborts the rest — which is
 * exactly how running these by hand went wrong.
 */
const SCHEMA_TABLES = [
  `CREATE TABLE IF NOT EXISTS sets (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, date TEXT, user TEXT,
     session TEXT, exercise TEXT, set_no INTEGER, weight REAL, reps REAL, rir REAL,
     notes TEXT, ex_notes TEXT, batch_id TEXT, set_ts TEXT, hr_avg REAL, hr_peak REAL,
     reps_assist REAL)`,
  `CREATE TABLE IF NOT EXISTS hr (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, date TEXT, user TEXT, session TEXT,
     source TEXT, start TEXT, finish TEXT, duration_min REAL, avg_hr REAL, max_hr REAL,
     pct_max REAL, min_above_80 REAL, z1 REAL, z2 REAL, z3 REAL, z4 REAL, z5 REAL,
     samples INTEGER, series_10s TEXT, workout_id TEXT, workout_type TEXT)`,
  `CREATE TABLE IF NOT EXISTS batches (batch_id TEXT PRIMARY KEY, ts TEXT)`,
  /* The order the exercises of a session are shown in, once someone has
     dragged them into one. One row per person and session, holding the
     order, the program it was dragged against, and the clock of the device
     that did it. `ts` is that device's clock and is only ever compared with
     itself, which is enough for last-drag-wins between two phones. */
  `CREATE TABLE IF NOT EXISTS ex_order (
     user TEXT, session TEXT, ord TEXT, program TEXT, ts INTEGER, saved TEXT,
     PRIMARY KEY (user, session))`,
];

// Columns added after a table first shipped. Appending here is the whole
// migration process now: no console, no ordering to get right.
const SCHEMA_COLUMNS = [
  ['sets', 'ex_notes',     'TEXT'],
  ['sets', 'reps_assist',  'REAL'],   // reps finished on the assist machine
  ['hr',   'workout_id',   'TEXT'],
  ['hr',   'workout_type', 'TEXT'],
  ['sets', 'ts_source',    'TEXT'],   // how set_ts was got: blank = ticked, else estimated (hevy-peak, hevy-even)
];

const SCHEMA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sets_lookup  ON sets (user, exercise, date)',
  'CREATE INDEX IF NOT EXISTS idx_sets_batch   ON sets (batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_sets_session ON sets (user, date)',
  'CREATE INDEX IF NOT EXISTS idx_hr_session   ON hr   (user, date)',
  'CREATE INDEX IF NOT EXISTS idx_hr_dedupe    ON hr   (user, start)',
];

let schemaReady = null;

function ensureSchema(env) {
  if (!env || !env.DB) return Promise.resolve();
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    for (const sql of SCHEMA_TABLES) await env.DB.prepare(sql).run();
    for (const [t, c, type] of SCHEMA_COLUMNS) {
      try { await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`).run(); }
      catch (e) { /* already there, which is the normal case */ }
    }
    for (const sql of SCHEMA_INDEXES) await env.DB.prepare(sql).run();
  })().catch(e => { schemaReady = null; throw e; });   // retry on the next request
  return schemaReady;
}

async function columnsOf(env, table) {
  try {
    const r = await env.DB.prepare(`SELECT name FROM pragma_table_info(?1)`).bind(table).all();
    return (r.results || []).map(x => x.name);
  } catch (e) { return null; }
}

/* ── Hevy pass-through ─────────────────────────────────────────────────
 * hevy-routines.html writes the program into Hevy as routines. Hevy's API
 * is not known to accept calls from a web page, so the page calls this and
 * this calls Hevy. The key is the caller's own, sent per request and never
 * stored; nothing touches the database. Only the three collections the page
 * needs are reachable, so this is not a general relay. */
const HEVY_PATH = /^\/v1\/(exercise_templates|routines|routine_folders)(\/[A-Za-z0-9-]+)?(\?(page|pageSize)=\d+(&(page|pageSize)=\d+)?)?$/;

async function hevyProxy(request, url) {
  const path = url.searchParams.get('path') || '';
  const key = request.headers.get('x-hevy-key') || '';
  if (!HEVY_PATH.test(path)) return json({ ok: false, error: 'path not allowed' }, 400);
  if (!/^[0-9a-fA-F-]{20,64}$/.test(key)) return json({ ok: false, error: 'missing or malformed Hevy API key' }, 401);
  if (!['GET', 'POST', 'PUT'].includes(request.method)) return json({ ok: false, error: 'method not allowed' }, 405);
  const init = { method: request.method, headers: { 'api-key': key, 'accept': 'application/json' } };
  if (request.method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = await request.text();
  }
  let res;
  try { res = await fetch('https://api.hevyapp.com' + path, init); }
  catch (e) { return json({ ok: false, error: 'could not reach Hevy: ' + e.message }, 502); }
  return new Response(await res.text(), {
    status: res.status,
    headers: { ...CORS, 'Content-Type': res.headers.get('content-type') || 'application/json' },
  });
}

/* ── Hevy sync, run by the Worker itself ───────────────────────────────
 * The same routines hevy-routines.html writes, without a phone in the loop:
 * the key is stored once in D1, the routines come from routines.json in
 * the repository (built from the program by tools/build-routines.js), the
 * weights come from the log. Calling ?action=hevy-sync again after a
 * program change updates the routines in place. Both calls are GETs so
 * they can be made from anywhere a URL can be opened. */
const ROUTINES_URL = 'https://raw.githubusercontent.com/Ikarus-eth/OperationLean/main/routines.json';
/* raw.githubusercontent caches for about five minutes whatever the query
   string, so a sync right after a push wrote the previous program. The
   contents API answers with the current commit; raw stays as the fallback
   if the API is rate-limited (60 calls an hour without a token). */
async function fetchRoutines() {
  try {
    const r = await fetch('https://api.github.com/repos/Ikarus-eth/OperationLean/contents/routines.json?ref=main',
      { headers: { accept: 'application/vnd.github.raw', 'user-agent': 'logbook-worker' }, cf: { cacheTtl: 0 } });
    if (r.ok) return await r.json();
  } catch (e) {}
  const r = await fetch(ROUTINES_URL + '?t=' + Date.now(), { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('routines.json: ' + r.status);
  return r.json();
}

async function settingsTable(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT, ts TEXT)').run();
}
async function getSetting(env, k) {
  await settingsTable(env);
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k = ?1').bind(k).first();
  return r ? r.v : null;
}
async function setSetting(env, k, v) {
  await settingsTable(env);
  await env.DB.prepare('INSERT INTO settings (k, v, ts) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, ts = ?3')
    .bind(k, v, new Date().toISOString()).run();
}

function hevyClient(key) {
  return async (method, path, body) => {
    const init = { method, headers: { 'api-key': key, accept: 'application/json' } };
    if (body) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch('https://api.hevyapp.com' + path, init);
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return { ok: res.ok, status: res.status, text, json: j || {} };
  };
}
function findIdIn(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.id != null && (typeof o.id === 'string' || typeof o.id === 'number')) return o.id;
  for (const v of Object.values(o)) {
    const hit = Array.isArray(v) ? (v.length ? findIdIn(v[0]) : null) : findIdIn(v);
    if (hit != null) return hit;
  }
  return null;
}
async function hevyListAll(h, path, key, size) {
  const out = [];
  for (let page = 1; page < 200; page++) {
    const r = await h('GET', `${path}?page=${page}&pageSize=${size}`);
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`${path}: ${r.status} ${r.text.slice(0, 200)}`);
    out.push(...(r.json[key] || []));
    if (!r.json.page_count || page >= r.json.page_count) break;
  }
  return out;
}
const dropNulls = o => { Object.keys(o).forEach(k => { if (o[k] == null) delete o[k]; }); return o; };

async function hevySync(env, user) {
  const key = await getSetting(env, 'hevy_key.' + user);
  if (!key) return { ok: false, error: 'no Hevy key stored for ' + user };
  let plan;
  try { plan = await fetchRoutines(); } catch (e) { return { ok: false, error: e.message }; }
  const routines = (plan.users || {})[user];
  if (!routines) return { ok: false, error: 'routines.json has nothing for ' + user };

  // Last logged sets per exercise, to open each routine set at that weight.
  const lastRows = await env.DB.prepare(`
    SELECT s.exercise, s.set_no, s.weight, s.reps FROM sets s
    JOIN (SELECT exercise, MAX(date) AS d FROM sets WHERE user = ?1 AND session != 'Daily' GROUP BY exercise) m
      ON s.exercise = m.exercise AND s.date = m.d
    WHERE s.user = ?1 ORDER BY s.exercise, s.set_no`).bind(user).all();
  const last = {};
  for (const r of lastRows.results || []) (last[r.exercise] = last[r.exercise] || []).push(r);

  const h = hevyClient(key);
  const report = { ok: true, user, built: plan.built, customs: [], routines: [] };
  const [templates, existing, folders] = await Promise.all([
    hevyListAll(h, '/v1/exercise_templates', 'exercise_templates', 100),
    hevyListAll(h, '/v1/routines', 'routines', 10),
    hevyListAll(h, '/v1/routine_folders', 'routine_folders', 10),
  ]);
  const ids = new Map(templates.map(t => [String(t.title).toLowerCase(), t.id]));

  for (const rt of routines) for (const x of rt.exercises) {
    if (ids.has(x.hevy.toLowerCase()) || !x.custom) continue;
    const r = await h('POST', '/v1/exercise_templates', x.custom);
    if (!r.ok) throw new Error(`custom ${x.hevy}: ${r.status} ${r.text.slice(0, 200)}`);
    let id = findIdIn(r.json);
    if (id == null) id = r.text.trim().replace(/"/g, '') || null;
    ids.set(x.hevy.toLowerCase(), String(id));
    report.customs.push(x.hevy);
  }

  let folder = folders.find(f => f.title === 'Logbook');
  let folderId = folder ? folder.id : null;

  for (const rt of routines) {
    const exercises = rt.exercises.map(x => {
      const prev = last[x.name] || [];
      const sets = x.body.sets.map((s, i) => {
        const p = prev[i] || prev[prev.length - 1];
        const out = { ...s };
        if (p) {
          const w = Number(p.weight), r = Number(p.reps);
          if ((x.type === 'weight_reps' || x.type === 'weight_duration') && Number.isFinite(w) && p.weight !== null && p.weight !== '') out.weight_kg = w;
          if ((x.type === 'duration' || x.type === 'weight_duration') && Number.isFinite(r) && r > 0) out.duration_seconds = Math.round(r * (x.timedUnit === 'min' ? 60 : 1));
        }
        return dropNulls(out);
      });
      return dropNulls({ ...x.body, exercise_template_id: ids.get(x.hevy.toLowerCase()), sets });
    });
    const missing = rt.exercises.filter((x, i) => !exercises[i].exercise_template_id).map(x => x.hevy);
    if (missing.length) { report.routines.push({ title: rt.title, ok: false, error: 'no Hevy exercise for ' + missing.join(', ') }); report.ok = false; continue; }
    const have = existing.find(e => e.title === rt.title);
    let r;
    if (have) {
      r = await h('PUT', `/v1/routines/${have.id}`, { routine: { title: rt.title, notes: rt.notes, exercises } });
    } else {
      if (folderId == null) {
        const f = await h('POST', '/v1/routine_folders', { routine_folder: { title: 'Logbook' } });
        folderId = f.ok ? findIdIn(f.json) : null;
      }
      r = await h('POST', '/v1/routines', { routine: { title: rt.title, folder_id: folderId, notes: rt.notes, exercises } });
    }
    report.routines.push({ title: rt.title, action: have ? 'updated' : 'created', ok: r.ok, status: r.status, error: r.ok ? undefined : r.text.slice(0, 300) });
    if (!r.ok) report.ok = false;
  }
  return report;
}

/* ── Hevy workouts into the log ────────────────────────────────────────
 * Sessions logged in Hevy on the watch come back here, so the log stays the
 * one place all training lives: carry-over, history, the CSV and ?action=log
 * all see them. Each workout is one batch ('hevy:' + id), replaced whole when
 * Hevy says it changed and removed when Hevy says it was deleted. A session
 * already logged in the Logbook for the same day is left alone, so logging
 * in both never doubles a day.
 *
 * Hevy keeps no time per set, so heart rate per set is estimated: each hard
 * set leaves a peak in the watch trace, and the peaks are matched to the sets
 * in order. When the trace has too few clear peaks, the sets are spread
 * evenly across the workout instead. ts_source says which was used. */
const HEVY_TZ = '+08:00';
// Every-day items are logged under session 'Daily', as the app does.
const DAILY_NAMES = new Set(['Pulls', 'Handstand']);               // the day a workout belongs to; Bali

function peakTimes(hrRow, fromMs, toMs, n) {
  const t0 = parseHRDate(hrRow.start);
  const v = String(hrRow.series_10s || '').split(',').map(Number);
  const cand = [];
  for (let i = 0; i < v.length; i++) {
    const t = t0 + i * 10000;
    if (t < fromMs || t > toMs + 60000 || !(v[i] > 0)) continue;
    let top = true;
    for (let k = Math.max(0, i - 3); k <= Math.min(v.length - 1, i + 3); k++) {
      if (k !== i && v[k] > v[i]) { top = false; break; }
      if (k > i && v[k] === v[i]) { top = false; break; }      // a plateau counts once, at its end
    }
    if (!top) continue;
    let low = v[i];
    for (let k = Math.max(0, i - 9); k < i; k++) if (v[k] > 0 && v[k] < low) low = v[k];
    if (v[i] - low >= 8) cand.push({ t: t + 10000, rise: v[i] - low });
  }
  if (cand.length < n) return null;
  return cand.sort((a, b) => b.rise - a.rise).slice(0, n).map(c => c.t).sort((a, b) => a - b);
}

async function importHevyWorkout(env, user, w, names, routineNotes) {
  const batch = 'hevy:' + w.id;
  const startMs = Date.parse(w.start_time), endMs = Date.parse(w.end_time);
  if (!Number.isFinite(startMs)) return { id: w.id, skipped: 'no start time' };
  const date = dayInZone(startMs, HEVY_TZ);
  const session = String(w.title || 'Hevy').split(' · ')[0].trim();

  const clash = await env.DB.prepare(
    "SELECT 1 FROM sets WHERE user = ?1 AND date = ?2 AND session = ?3 AND (batch_id IS NULL OR batch_id NOT LIKE 'hevy:%') LIMIT 1"
  ).bind(user, date, session).first();
  if (clash) return { id: w.id, date, session, skipped: 'already logged in the Logbook' };

  const perEx = [];
  for (const ex of (w.exercises || [])) {
    const rows = [];
    perEx.push({ superset: ex.superset_id ?? null, rows });
    const name = names[ex.title] || ex.title;
    const exNote = ex.notes && !routineNotes.has(String(ex.notes).trim()) ? String(ex.notes) : '';
    let n = 0;
    for (const s of (ex.sets || [])) {
      if (s.type === 'warmup') continue;
      n++;
      const timed = s.duration_seconds != null && s.reps == null;
      rows.push({
        name, set_no: n, session: DAILY_NAMES.has(name) || session === 'Pulls' ? 'Daily' : session,
        weight: s.weight_kg ?? null,
        reps: timed ? s.duration_seconds : (s.reps ?? null),
        rir: Number.isFinite(Number(s.rpe)) && s.rpe != null ? Math.max(0, 10 - Number(s.rpe)) : null,
        exNote,
      });
    }
  }
  /* The order the sets were done in, which the heart-rate peaks follow:
     straight down for a lone exercise, round-robin for a superset (A1, B1,
     A2, B2…), since the watch walks a superset that way. */
  const rows = [];
  for (let i = 0; i < perEx.length; ) {
    let j = i + 1;
    if (perEx[i].superset != null) while (j < perEx.length && perEx[j].superset === perEx[i].superset) j++;
    const group = perEx.slice(i, j);
    const most = Math.max(...group.map(g => g.rows.length));
    for (let k = 0; k < most; k++) group.forEach(g => { if (g.rows[k]) rows.push(g.rows[k]); });
    i = j;
  }
  if (!rows.length) return { id: w.id, date, session, skipped: 'no working sets' };

  // When each set ended: from the heart-rate trace if it shows them, else even.
  let times = null, source = 'hevy-even';
  const hrRows = (await env.DB.prepare('SELECT start, finish, series_10s FROM hr WHERE user = ?1 AND date = ?2')
    .bind(user, date).all()).results || [];
  const hrRow = hrRows.find(h => parseHRDate(h.start) <= endMs && parseHRDate(h.finish) >= startMs);
  if (hrRow && Number.isFinite(endMs)) {
    times = peakTimes(hrRow, startMs, endMs, rows.length);
    if (times) source = 'hevy-peak';
  }
  if (!times) {
    const end = Number.isFinite(endMs) ? endMs : startMs + 3600000;
    const step = (end - startMs) / (rows.length + 1);
    times = rows.map((_, i) => Math.round(startMs + step * (i + 1)));
  }

  const now = new Date().toISOString();
  const ins = env.DB.prepare(`INSERT INTO sets (ts,date,user,session,exercise,set_no,weight,reps,rir,notes,ex_notes,batch_id,set_ts,ts_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const stmts = [env.DB.prepare('DELETE FROM sets WHERE batch_id = ?').bind(batch)];
  rows.forEach((r, i) => stmts.push(ins.bind(now, date, user, r.session, r.name, r.set_no, r.weight, r.reps, r.rir,
    str(w.description || ''), r.exNote, batch, new Date(times[i]).toISOString(), source)));
  await env.DB.batch(stmts);
  if (hrRow) await env.DB.prepare("UPDATE hr SET session = ?1 WHERE user = ?2 AND start = ?3 AND (session IS NULL OR session = '')")
    .bind(session, user, hrRow.start).run();
  const attributed = await attributeDay(env, user, date);
  return { id: w.id, date, session, sets: rows.length, timing: source, attributed };
}

async function hevyPull(env, user) {
  const key = await getSetting(env, 'hevy_key.' + user);
  if (!key) return { ok: false, user, error: 'no Hevy key stored' };
  const since = (await getSetting(env, 'hevy_since.' + user)) || '2026-10-17T00:00:00Z';
  const startedAt = new Date().toISOString();
  const h = hevyClient(key);

  let plan = { names: {}, users: {} };
  try { plan = await fetchRoutines(); } catch (e) {}
  const names = (plan.names || {})[user] || {};
  const routineNotes = new Set();
  ((plan.users || {})[user] || []).forEach(rt => rt.exercises.forEach(x => x.body.notes && routineNotes.add(String(x.body.notes).trim())));

  const events = [];
  for (let page = 1; page < 100; page++) {
    const r = await h('GET', `/v1/workouts/events?page=${page}&pageSize=10&since=${encodeURIComponent(since)}`);
    if (r.status === 404) break;
    if (!r.ok) return { ok: false, user, error: `events: ${r.status} ${r.text.slice(0, 200)}` };
    events.push(...(r.json.events || []));
    if (!r.json.page_count || page >= r.json.page_count) break;
  }

  const out = { ok: true, user, since, imported: [], deleted: [] };
  for (const e of events) {
    if (e.type === 'deleted') {
      const id = e.id || (e.workout && e.workout.id);
      if (id) { await env.DB.prepare('DELETE FROM sets WHERE batch_id = ?').bind('hevy:' + id).run(); out.deleted.push(id); }
    } else if (e.workout) {
      out.imported.push(await importHevyWorkout(env, user, e.workout, names, routineNotes));
    }
  }
  await setSetting(env, 'hevy_since.' + user, startedAt);
  return out;
}

/* The log as text a person or a model can read in one go: one line per
   exercise per session, every set as weight×reps, RIR, and the peak heart
   rate of the set, plus the session's heart-rate summary from the watch. */
async function logText(env, user, from, to) {
  const sets = (await env.DB.prepare(`SELECT date, session, exercise, set_no, weight, reps, reps_assist, rir, hr_peak, ts_source, ex_notes
    FROM sets WHERE user = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date, id`).bind(user, from, to).all()).results || [];
  const hr = (await env.DB.prepare(`SELECT date, duration_min, avg_hr, max_hr, min_above_80, z1, z2, z3, z4, z5, workout_type
    FROM hr WHERE user = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date, start`).bind(user, from, to).all()).results || [];
  const lines = [`# ${user} ${from}..${to}  set = kg×reps (s = seconds) rRIR @peak bpm; ~ = bpm from estimated set times`];
  const byDay = {};
  for (const s of sets) {
    const d = (byDay[s.date] = byDay[s.date] || {});
    const k = s.session + '\u0000' + s.exercise;
    (d[k] = d[k] || []).push(s);
  }
  const days = [...new Set(sets.map(s => s.date).concat(hr.map(h => h.date)))].sort();
  for (const day of days) {
    for (const h of hr.filter(x => x.date === day))
      lines.push(`${day} HR ${h.workout_type || 'workout'}: ${h.duration_min} min, avg ${h.avg_hr}, max ${h.max_hr}, >80% ${h.min_above_80} min, zones ${[h.z1, h.z2, h.z3, h.z4, h.z5].join('/')}`);
    for (const [k, ss] of Object.entries(byDay[day] || {})) {
      const [session, exercise] = k.split('\u0000');
      const parts = ss.map(s => {
        let p = (s.weight != null && s.weight !== '' ? s.weight + '×' : '') + (s.reps ?? '');
        if (s.reps_assist) p += '+' + s.reps_assist + 'a';
        if (s.rir != null && s.rir !== '') p += ' r' + s.rir;
        if (s.hr_peak) p += ' @' + (s.ts_source ? '~' : '') + s.hr_peak;
        return p;
      });
      lines.push(`${day} ${session} | ${exercise}: ${parts.join(', ')}${ss[0].ex_notes ? '  // ' + String(ss[0].ex_notes).replace(/\s+/g, ' ') : ''}`);
    }
  }
  return lines.join('\n');
}

/* ── push log ──────────────────────────────────────────────────────────
 * One row per request that looks like it came from the phone rather than
 * the app, with what it answered. Health Auto Export failing silently is
 * otherwise invisible from here: no row in hr looks the same whether the
 * automation never ran, sent the wrong header, or sent a shape the parser
 * missed. Holds no health data, only sizes, keys and the reply. */
async function logPush(env, row) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT, user TEXT, header TEXT, bytes INTEGER, keys TEXT, status INTEGER, reply TEXT)`).run();
    await env.DB.prepare('INSERT INTO push_log (ts,user,header,bytes,keys,status,reply) VALUES (?,?,?,?,?,?,?)')
      .bind(new Date().toISOString(), row.user, row.header, row.bytes, row.keys, row.status, String(row.reply).slice(0, 400)).run();
    await env.DB.prepare('DELETE FROM push_log WHERE id < (SELECT MAX(id) - 200 FROM push_log)').run();
  } catch (e) {}
}

export default {
  /* Every 30 minutes (wrangler.toml): pull new Hevy workouts for everyone
     with a stored key. */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    try { await ensureSchema(env); } catch (e) {}
    await settingsTable(env);
    const keys = (await env.DB.prepare("SELECT k FROM settings WHERE k LIKE 'hevy_key.%'").all()).results || [];
    for (const { k } of keys) {
      try { await hevyPull(env, k.slice('hevy_key.'.length)); } catch (e) { console.log('hevy pull', k, e.message); }
    }
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // Before the database and the secret: it uses neither.
    if (url.searchParams.get('action') === 'hevy') return hevyProxy(request, url);

    // Accept either a plain secret variable or a Secrets Store binding,
    // which hands back an object with an async get() instead of a string.
    let SECRET = env.LOGBOOK_SECRET;
    if (SECRET && typeof SECRET.get === 'function') SECRET = await SECRET.get();

    // Bring the database up to what this version of the code expects. Failing
    // here is not fatal on its own; the query that needs the column will say so.
    let schemaError = null;
    try { await ensureSchema(env); } catch (e) { schemaError = e.message; }

    // Health check on the bare URL, so setup can be verified by clicking it.
    if (request.method === 'GET' && !url.searchParams.get('action')) {
      const health = {
        ok: true,
        worker: 'logbook',
        version: VERSION,
        features: FEATURES,
        secret_set: !!SECRET,
        d1_bound: !!env.DB,
        tables: null,
        rows: null,
      };
      if (env.DB) {
        try {
          const t = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          ).all();
          health.tables = (t.results || []).map(r => r.name);
          if (health.tables.includes('sets')) {
            const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sets').first();
            health.rows = n ? n.n : 0;
          }
        } catch (e) {
          health.tables = 'query failed: ' + e.message;
        }
      }
      health.schema = schemaError ? ('migration failed: ' + schemaError) : 'ok';
      if (env.DB) {
        health.columns = {
          sets: await columnsOf(env, 'sets'),
          hr: await columnsOf(env, 'hr'),
        };
      }
      health.ready = !!SECRET && !!env.DB && !schemaError
        && Array.isArray(health.tables)
        && health.tables.includes('sets') && health.tables.includes('hr')
        && SCHEMA_COLUMNS.every(([t, c]) =>
             !health.columns || !health.columns[t] || health.columns[t].includes(c));
      return json(health);
    }

    if (!SECRET) return json({
      ok: false,
      error: 'LOGBOOK_SECRET is not set. Add it under Settings > Variables and Secrets, then redeploy.'
    }, 500);

    if (!env.DB) return json({
      ok: false,
      error: 'No D1 binding named DB. Add it under Settings > Bindings, then redeploy.'
    }, 500);

    /* ── read ──────────────────────────────────────────────────── */
    if (request.method === 'GET') {
      const action = url.searchParams.get('action');

      if (action === 'pushlog') {
        let rows = [];
        try { rows = (await env.DB.prepare('SELECT ts,user,header,bytes,keys,status,reply FROM push_log ORDER BY id DESC LIMIT 30').all()).results || []; } catch (e) {}
        return json({ ok: true, pushes: rows });
      }

      if (action === 'log') {
        const user = str(url.searchParams.get('user')).toLowerCase() || 'ikarus';
        const to = url.searchParams.get('to') || '9999-12-31';
        const from = url.searchParams.get('from') || new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
        return new Response(await logText(env, user, from, to), { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      }

      /* One-off repair after the trailing-space pushes: names in hr are
         trimmed and lower-cased, then every affected day is matched again. */
      if (action === 'repair-hr') {
        if (url.searchParams.get('secret') !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
        const bad = (await env.DB.prepare('SELECT DISTINCT user, date FROM hr WHERE user != LOWER(TRIM(user))').all()).results || [];
        await env.DB.prepare('UPDATE hr SET user = LOWER(TRIM(user)) WHERE user != LOWER(TRIM(user))').run();
        let attributed = 0;
        for (const b of bad) attributed += await attributeDay(env, String(b.user).trim().toLowerCase(), b.date);
        return json({ ok: true, fixed_days: bad.length, attributed });
      }

      if (action === 'hevy-key' || action === 'hevy-sync' || action === 'hevy-pull') {
        if (url.searchParams.get('secret') !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
        const user = str(url.searchParams.get('user')).toLowerCase();
        if (!/^[a-z]+$/.test(user)) return json({ ok: false, error: 'add &user=ikarus' }, 400);
        if (action === 'hevy-key') {
          const key = str(url.searchParams.get('key')).trim();
          if (!/^[0-9a-fA-F-]{20,64}$/.test(key)) return json({ ok: false, error: 'that does not look like a Hevy API key' }, 400);
          const check = await hevyClient(key)('GET', '/v1/routines?page=1&pageSize=1');
          if (!check.ok && check.status !== 404) return json({ ok: false, error: 'Hevy refused the key: ' + check.status + ' ' + check.text.slice(0, 200) }, 400);
          await setSetting(env, 'hevy_key.' + user, key);
          return json({ ok: true, stored: user });
        }
        if (action === 'hevy-pull') {
          try { return json(await hevyPull(env, user)); }
          catch (e) { return json({ ok: false, error: e.message }, 502); }
        }
        try { return json(await hevySync(env, user)); }
        catch (e) { return json({ ok: false, error: e.message }, 502); }
      }

      if (action === 'last') {
        const user = url.searchParams.get('user') || '';
        // For each exercise, the rows belonging to its most recent date.
        // reps_assist belongs here for the same reason it is in `day`: the
        // pull-up ladder is three numbers, and a carry-over missing one of
        // them opens the row half empty every single week.
        //
        // With date and session, the session asking is left out, and so are
        // that day's every-day rows, which belong to it. Otherwise the first
        // save of a session made it its own history: the rest of the sets
        // were suggested from the first one, labelled as carried over from
        // today, and "beat last time" compared each set with itself. Without
        // them nothing is left out, as before.
        const date = url.searchParams.get('date') || '';
        const session = url.searchParams.get('session') || '';
        const rs = await env.DB.prepare(`
          SELECT s.exercise, s.date, s.set_no, s.weight, s.reps, s.reps_assist, s.rir
          FROM sets s
          JOIN (
            SELECT exercise, MAX(date) AS d
            FROM sets WHERE user = ?1 AND NOT (date = ?2 AND (session = ?3 OR session = 'Daily'))
            GROUP BY exercise
          ) m ON s.exercise = m.exercise AND s.date = m.d
          WHERE s.user = ?1 AND NOT (s.date = ?2 AND (s.session = ?3 OR s.session = 'Daily'))
          ORDER BY s.exercise, s.set_no
        `).bind(user, date, session).all();

        const last = {};
        for (const r of rs.results) {
          if (!last[r.exercise]) last[r.exercise] = { date: r.date, sets: [] };
          last[r.exercise].sets.push({
            w: r.weight === null ? '' : String(r.weight),
            r: r.reps   === null ? '' : String(r.reps),
            r2: r.reps_assist === null || r.reps_assist === undefined ? '' : String(r.reps_assist),
            rir: r.rir  === null ? '' : String(r.rir),
          });
        }
        return json({ ok: true, last });
      }

      if (action === 'day') {
        const user = str(url.searchParams.get('user'));
        const date = str(url.searchParams.get('date'));
        const rs = await env.DB.prepare(
          `SELECT workout_type, duration_min, avg_hr, max_hr, pct_max, min_above_80, source
           FROM hr WHERE user = ?1 AND date = ?2 ORDER BY start`
        ).bind(user, date).all();
        const ss = await env.DB.prepare(
          `SELECT session, exercise, set_no, weight, reps, reps_assist, rir, notes, ex_notes, set_ts, hr_avg, hr_peak
           FROM sets WHERE user = ?1 AND date = ?2 ORDER BY id`
        ).bind(user, date).all();
        return json({ ok: true, hr: rs.results || [], sets: ss.results || [] });
      }

      if (action === 'order') {
        const user = str(url.searchParams.get('user'));
        const rs = await env.DB.prepare(
          'SELECT session, ord, program, ts FROM ex_order WHERE user = ?1'
        ).bind(user).all();
        const order = {};
        for (const r of rs.results || []) {
          let ord = null, program = null;
          try { ord = JSON.parse(r.ord); program = JSON.parse(r.program || '[]'); } catch (e) { continue; }
          if (!Array.isArray(ord)) continue;
          order[str(r.session)] = { order: ord, program: Array.isArray(program) ? program : [], ts: Number(r.ts) || 0 };
        }
        return json({ ok: true, order });
      }

      if (action === 'csv') {
        const table = url.searchParams.get('table') === 'hr' ? 'hr' : 'sets';
        const rs = await env.DB.prepare(
          `SELECT * FROM ${table} ORDER BY date, id`
        ).all();

        const rows = rs.results || [];
        const cols = rows.length
          ? Object.keys(rows[0])
          : (table === 'sets'
              ? ['id','ts','date','user','session','exercise','set_no','weight','reps','reps_assist','rir','notes','ex_notes','batch_id','set_ts','hr_avg','hr_peak']
              : ['id','ts','date','user','session','source','start','finish','duration_min','avg_hr','max_hr','pct_max','min_above_80','z1','z2','z3','z4','z5','samples','series_10s','workout_id','workout_type']);

        const esc = v => {
          const s = v === null || v === undefined ? '' : String(v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const body = [cols.join(',')]
          .concat(rows.map(r => cols.map(c => esc(r[c])).join(',')))
          .join('\n');

        return new Response(body, {
          headers: {
            ...CORS,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `inline; filename="${table}.csv"`,
            'Cache-Control': 'no-store',
          },
        });
      }

      return json({ ok: false, error: 'unknown action' }, 400);
    }

    /* ── write ─────────────────────────────────────────────────── */
    if (request.method === 'POST') {
      const raw = await request.text();
      let body = null;
      try { body = JSON.parse(raw); } catch (e) { /* maybe not JSON at all */ }

      // Anything addressed to a person by URL, or carrying the header, is the
      // phone; log what it sent and what it got back.
      const fromPhone = url.searchParams.get('user') || request.headers.get('x-logbook-secret');
      if (fromPhone) {
        const given = request.headers.get('x-logbook-secret') || url.searchParams.get('secret') || '';
        const keysOf = o => {
          if (!o || typeof o !== 'object') return typeof o;
          const d = o.data && typeof o.data === 'object' ? o.data : null;
          return Object.keys(o).join('|') + (d ? ' data:' + Object.keys(d).map(k => k + (Array.isArray(d[k]) ? '[' + d[k].length + ']' : '')).join('|') : '');
        };
        const meta = { user: str(url.searchParams.get('user')), header: given ? (given === SECRET ? 'ok' : 'wrong') : 'missing',
          bytes: raw.length, keys: keysOf(body) };
        const res = await handlePost();
        const clone = res.clone();
        await logPush(env, { ...meta, status: res.status, reply: await clone.text() });
        return res;
      }
      return handlePost();

      async function handlePost() {

      /* A bare list of numbers in the body, with everything else in the query
         string. Assembling JSON around a variable is the fiddliest step in
         Shortcuts, and this removes it: the body becomes one Combine Text. */
      if (!body || typeof body !== 'object') {
        const t = raw.trim();
        if (t && /^[\d\s.,]+$/.test(t)) body = { values: t };
        else return json({ ok: false, error: 'could not read the request body' }, 400);
      }

      // Query string fills in anything the body did not say.
      for (const k of ['day', 'name', 'step_s', 'tz', 'id', 'start', 'end', 'trim']) {
        const v = url.searchParams.get(k);
        if (v && body[k] === undefined) body[k] = v;
      }

      /* A payload from Health Auto Export on the phone rather than from the
         app. It cannot send a body field, so its secret comes from a header or
         the query string, and the person comes from ?user= on the URL: each
         phone gets its own URL. */
      const looksLikeWatch = body && body.data &&
        (Array.isArray(body.data.workouts) || Array.isArray(body.data.metrics));
      const looksLikeSimple = body && body.values !== undefined;

      if (looksLikeWatch || looksLikeSimple || url.searchParams.get('action') === 'hr') {
        const given = request.headers.get('x-logbook-secret') || url.searchParams.get('secret') || '';
        if (given !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
        // Trimmed: a URL typed on a phone picked up a trailing space, and every
        // workout then belonged to "ikarus ", whom no set ever matched.
        const user = str(url.searchParams.get('user')).trim().toLowerCase();
        if (!user) return json({ ok: false, error: 'add ?user=ikarus to the URL' }, 400);
        const payload = looksLikeWatch ? body : (normaliseSimple(body) || body);
        try {
          const r = await ingestWorkouts(env, user, payload);
          return json({ ok: true, ...r });
        } catch (e) {
          return json({ ok: false, error: 'ingest failed: ' + e.message }, 500);
        }
      }

      if (body.secret !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

      /* ── exercise order ─────────────────────────────────────────
       * Not training data: no date, no sets, one row per person and session
       * that says what order the screen puts the exercises in. It is sent on
       * its own rather than with a sync, because dragging is not a save and
       * happens on days nothing is ticked.
       *
       * Last drag wins, judged by the dragging device's own clock. A phone
       * that was offline for a week and comes back with an older drag is
       * refused by the WHERE below rather than undoing a newer one. Two
       * devices whose clocks disagree by more than the gap between two drags
       * would decide it wrong, which is a fair trade for not needing a
       * server clock the offline case cannot ask for.
       */
      if (Array.isArray(body.orders) || body.order) {
        const list = Array.isArray(body.orders) ? body.orders : [body.order];
        const now = new Date().toISOString();
        const stmts = [];
        const up = env.DB.prepare(`
          INSERT INTO ex_order (user, session, ord, program, ts, saved)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(user, session) DO UPDATE SET
            ord = excluded.ord, program = excluded.program,
            ts = excluded.ts, saved = excluded.saved
          WHERE excluded.ts >= ex_order.ts`);
        for (const o of list) {
          const user = str(o && o.user), session = str(o && o.session);
          if (!user || !session || !Array.isArray(o.order)) {
            return json({ ok: false, error: 'an order needs user, session and order[]' }, 400);
          }
          stmts.push(up.bind(user, session, JSON.stringify(o.order),
            JSON.stringify(Array.isArray(o.program) ? o.program : []), Number(o.ts) || 0, now));
        }
        if (!stmts.length) return json({ ok: true, saved: 0 });
        try {
          await env.DB.batch(stmts);
        } catch (e) {
          return json({ ok: false, error: 'database write failed: ' + e.message }, 500);
        }
        return json({ ok: true, saved: stmts.length });
      }

      /* ── continuous save ────────────────────────────────────────
       * The app saves as you tick rather than once at the end, so the same
       * screen is written over and over. Appending would pile up duplicates,
       * and would have no way to express unticking a set or fixing a weight.
       * So a sync replaces everything already stored for that person, date
       * and session. Sending it twice changes nothing; sending it with one
       * set removed removes that set. The screen is the truth.
       *
       * 'Daily' rows go with it: they belong to the day, not the split, and
       * the same screen holds them whichever session is picked. */
      if (body.sync === true) {
        const user = str(body.user), date = str(body.date), session = str(body.session);
        if (!user || !date || !session) {
          return json({ ok: false, error: 'sync needs user, date and session' }, 400);
        }
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const now = new Date().toISOString();
        const stmts = [];

        stmts.push(env.DB.prepare(
          "DELETE FROM sets WHERE user = ? AND date = ? AND (session = ? OR session = 'Daily')"
        ).bind(user, date, session));

        const insSet = env.DB.prepare(`
          INSERT INTO sets
            (ts,date,user,session,exercise,set_no,weight,reps,reps_assist,rir,notes,ex_notes,
             batch_id,set_ts,hr_avg,hr_peak)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const r of rows) {
          stmts.push(insSet.bind(
            now, str(r.date), str(r.user), str(r.session), str(r.exercise),
            num(r.set), num(r.weight), num(r.reps), num(r.reps_assist), num(r.rir),
            str(r.notes), str(r.ex_notes), 'sync', str(r.set_ts),
            num(r.hr_avg), num(r.hr_peak)
          ));
        }

        /* A hand-attached file replaces an earlier hand-attached one. Anything
           the phone pushed is left alone: the watch knows better than a file. */
        const hr = body.hr || null;
        if (hr) {
          stmts.push(env.DB.prepare(
            "DELETE FROM hr WHERE user = ? AND date = ? AND (source IS NULL OR source NOT LIKE 'watch:%')"
          ).bind(user, date));
          stmts.push(env.DB.prepare(`
            INSERT INTO hr (ts,date,user,session,source,start,finish,duration_min,avg_hr,max_hr,
              pct_max,min_above_80,z1,z2,z3,z4,z5,samples,series_10s)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
            now, str(hr.date), str(hr.user), str(hr.session), str(hr.source),
            str(hr.start), str(hr.end), num(hr.duration_min), num(hr.avg_hr), num(hr.max_hr),
            num(hr.pct_max), num(hr.min_above_80),
            num(hr.z1), num(hr.z2), num(hr.z3), num(hr.z4), num(hr.z5),
            num(hr.samples), str(hr.series_10s)
          ));
        }

        try {
          await env.DB.batch(stmts);
        } catch (e) {
          return json({ ok: false, error: 'database write failed: ' + e.message }, 500);
        }

        let attributed = 0;
        try {
          if (rows.length) {
            await env.DB.prepare(
              "UPDATE hr SET session = ? WHERE user = ? AND date = ? AND (session IS NULL OR session = '')"
            ).bind(session, user, date).run();
          }
          attributed = await attributeDay(env, user, date);
        } catch (e) { /* the sets are safe; attribution retries on the next sync */ }

        return json({ ok: true, stored: rows.length, attributed, at: now });
      }


      const rows = body.rows || [];
      const hr = body.hr || null;
      const batchId = str(body.batchId);
      if (!rows.length && !hr) return json({ ok: false, error: 'nothing to write' }, 400);

      // A session queued offline and retried must not write twice.
      if (batchId) {
        const dup = await env.DB.prepare('SELECT 1 FROM sets WHERE batch_id = ? LIMIT 1')
          .bind(batchId).first();
        if (dup) return json({ ok: true, written: 0, duplicate: true });
      }

      const now = new Date().toISOString();
      const stmts = [];

      const insSet = env.DB.prepare(`
        INSERT INTO sets
          (ts,date,user,session,exercise,set_no,weight,reps,reps_assist,rir,notes,ex_notes,
           batch_id,set_ts,hr_avg,hr_peak)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      for (const r of rows) {
        stmts.push(insSet.bind(
          now, str(r.date), str(r.user), str(r.session), str(r.exercise),
          num(r.set), num(r.weight), num(r.reps), num(r.reps_assist), num(r.rir),
          str(r.notes), str(r.ex_notes), batchId, str(r.set_ts),
          num(r.hr_avg), num(r.hr_peak)
        ));
      }

      if (hr) {
        stmts.push(env.DB.prepare(`
          INSERT INTO hr
            (ts,date,user,session,source,start,finish,duration_min,avg_hr,max_hr,
             pct_max,min_above_80,z1,z2,z3,z4,z5,samples,series_10s)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          now, str(hr.date), str(hr.user), str(hr.session), str(hr.source),
          str(hr.start), str(hr.end), num(hr.duration_min), num(hr.avg_hr), num(hr.max_hr),
          num(hr.pct_max), num(hr.min_above_80),
          num(hr.z1), num(hr.z2), num(hr.z3), num(hr.z4), num(hr.z5),
          num(hr.samples), str(hr.series_10s)
        ));
      }

      try {
        if (stmts.length) await env.DB.batch(stmts);
      } catch (e) {
        return json({ ok: false, error: 'database write failed: ' + e.message }, 500);
      }

      /* The watch may have got here first, or may arrive tonight. Either way
         the day is re-attributed now, and again when the trace lands. */
      let attributed = 0;
      try {
        const days = new Set();
        for (const r of rows) if (r.date && r.user) days.add(str(r.user) + '|' + str(r.date));
        if (hr && hr.date && hr.user) days.add(str(hr.user) + '|' + str(hr.date));
        for (const key of days) {
          const [u, d] = key.split('|');
          const sess = rows.find(r => str(r.user) === u && str(r.date) === d && str(r.session) !== 'Daily');
          if (sess) {
            await env.DB.prepare(
              "UPDATE hr SET session = ? WHERE user = ? AND date = ? AND (session IS NULL OR session = '')"
            ).bind(str(sess.session), u, d).run();
          }
          attributed += await attributeDay(env, u, d);
        }
      } catch (e) { /* the sets are already safe; attribution retries next write */ }

      return json({ ok: true, written: rows.length, hr: !!hr, attributed });
      }
    }

    return json({ ok: false, error: 'method not allowed' }, 405);
  },
};
