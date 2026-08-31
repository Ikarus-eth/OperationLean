/**
 * Logbook — Cloudflare Worker backend.
 *
 * Replaces the Google Apps Script. Speaks the same API, so index.html needs
 * no code change: only the ENDPOINT value.
 *
 *   GET  /                                   health check                (open)
 *   GET  ?action=last&user=ikarus            last session per exercise   (open)
 *   GET  ?action=day&user=&date=             what the watch sent that day (open)
 *   GET  ?action=csv&table=sets              whole log as CSV            (open)
 *   POST { secret, batchId, rows[], hr }     append a session         (secret)
 *   POST ?user=ikarus  {data:{workouts}}     Health Auto Export push  (secret)
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    const s = samplesOf(w);
    const sum = summariseHR(s, maxhr);
    if (!sum) { skipped++; continue; }
    if (sum.duration_min < MIN_WORKOUT_MIN) { skipped++; continue; }

    const date = localDayOf(w.start) || localDayOf(new Date(sum.start).toISOString());
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // Accept either a plain secret variable or a Secrets Store binding,
    // which hands back an object with an async get() instead of a string.
    let SECRET = env.LOGBOOK_SECRET;
    if (SECRET && typeof SECRET.get === 'function') SECRET = await SECRET.get();

    // Health check on the bare URL, so setup can be verified by clicking it.
    if (request.method === 'GET' && !url.searchParams.get('action')) {
      const health = {
        ok: true,
        worker: 'logbook',
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
      health.ready = !!SECRET && !!env.DB
        && Array.isArray(health.tables)
        && health.tables.includes('sets') && health.tables.includes('hr');
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

      if (action === 'last') {
        const user = url.searchParams.get('user') || '';
        // For each exercise, the rows belonging to its most recent date.
        const rs = await env.DB.prepare(`
          SELECT s.exercise, s.date, s.set_no, s.weight, s.reps, s.rir
          FROM sets s
          JOIN (
            SELECT exercise, MAX(date) AS d
            FROM sets WHERE user = ?1 GROUP BY exercise
          ) m ON s.exercise = m.exercise AND s.date = m.d
          WHERE s.user = ?1
          ORDER BY s.exercise, s.set_no
        `).bind(user).all();

        const last = {};
        for (const r of rs.results) {
          if (!last[r.exercise]) last[r.exercise] = { date: r.date, sets: [] };
          last[r.exercise].sets.push({
            w: r.weight === null ? '' : String(r.weight),
            r: r.reps   === null ? '' : String(r.reps),
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
        return json({ ok: true, hr: rs.results || [] });
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
              ? ['id','ts','date','user','session','exercise','set_no','weight','reps','rir','notes','ex_notes','batch_id','set_ts','hr_avg','hr_peak']
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
      let body;
      try { body = await request.json(); }        // parses regardless of content-type
      catch (e) { return json({ ok: false, error: 'could not read the request body' }, 400); }

      /* A payload from Health Auto Export on the phone rather than from the
         app. It cannot send a body field, so its secret comes from a header or
         the query string, and the person comes from ?user= on the URL: each
         phone gets its own URL. */
      const looksLikeWatch = body && body.data &&
        (Array.isArray(body.data.workouts) || Array.isArray(body.data.metrics));
      if (looksLikeWatch || url.searchParams.get('action') === 'hr') {
        const given = request.headers.get('x-logbook-secret') || url.searchParams.get('secret') || '';
        if (given !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);
        const user = str(url.searchParams.get('user')).toLowerCase();
        if (!user) return json({ ok: false, error: 'add ?user=ikarus to the URL' }, 400);
        try {
          const r = await ingestWorkouts(env, user, body);
          return json({ ok: true, ...r });
        } catch (e) {
          return json({ ok: false, error: 'ingest failed: ' + e.message }, 500);
        }
      }

      if (body.secret !== SECRET) return json({ ok: false, error: 'unauthorized' }, 401);

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
          (ts,date,user,session,exercise,set_no,weight,reps,rir,notes,ex_notes,
           batch_id,set_ts,hr_avg,hr_peak)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      for (const r of rows) {
        stmts.push(insSet.bind(
          now, str(r.date), str(r.user), str(r.session), str(r.exercise),
          num(r.set), num(r.weight), num(r.reps), num(r.rir),
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

    return json({ ok: false, error: 'method not allowed' }, 405);
  },
};
