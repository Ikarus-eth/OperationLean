/**
 * Logbook — Cloudflare Worker backend.
 *
 * Replaces the Google Apps Script. Speaks the same API, so index.html needs
 * no code change: only the ENDPOINT value.
 *
 *   GET  ?action=last&user=ikarus            last session per exercise   (open)
 *   GET  ?action=csv&table=sets              whole log as CSV            (open)
 *   POST { secret, batchId, rows[], hr }     append a session         (secret)
 *
 * Reads are deliberately open: the log is training data and nothing here can
 * reach any other account. Writes still need the secret, so nobody can drop
 * junk rows in and corrupt the carried-over values the app reads back.
 *
 * Bindings required (set in the Cloudflare dashboard):
 *   DB              — D1 database binding
 *   LOGBOOK_SECRET  — secret text, must match SECRET in index.html
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const SECRET = env.LOGBOOK_SECRET;
    if (!SECRET) return json({ ok: false, error: 'LOGBOOK_SECRET is not set on the Worker' }, 500);

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

      if (action === 'csv') {
        const table = url.searchParams.get('table') === 'hr' ? 'hr' : 'sets';
        const rs = await env.DB.prepare(
          `SELECT * FROM ${table} ORDER BY date, id`
        ).all();

        const rows = rs.results || [];
        const cols = rows.length
          ? Object.keys(rows[0])
          : (table === 'sets'
              ? ['id','ts','date','user','session','exercise','set_no','weight','reps','rir','notes','batch_id','set_ts','hr_avg','hr_peak']
              : ['id','ts','date','user','session','source','start','finish','duration_min','avg_hr','max_hr','pct_max','min_above_80','z1','z2','z3','z4','z5','samples','series_10s']);

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
          (ts,date,user,session,exercise,set_no,weight,reps,rir,notes,batch_id,set_ts,hr_avg,hr_peak)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      for (const r of rows) {
        stmts.push(insSet.bind(
          now, str(r.date), str(r.user), str(r.session), str(r.exercise),
          num(r.set), num(r.weight), num(r.reps), num(r.rir),
          str(r.notes), batchId, str(r.set_ts), num(r.hr_avg), num(r.hr_peak)
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

      return json({ ok: true, written: rows.length, hr: !!hr });
    }

    return json({ ok: false, error: 'method not allowed' }, 405);
  },
};
