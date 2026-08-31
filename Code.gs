/**
 * Logbook — Google Apps Script backend.
 *
 * Bind to your Google Sheet: Extensions ▸ Apps Script, paste this in,
 * change SECRET, then Deploy ▸ New deployment ▸ Web app
 *   Execute as:      Me
 *   Who has access:  Anyone
 * Copy the /exec URL into index.html.
 *
 * Safe to paste over an older version. Missing columns and the hr tab are
 * added on the next write; existing rows keep their values in place.
 */

const SECRET     = 'change-me-to-something-long-and-random';
const SHEET_NAME = 'log';
const HR_SHEET   = 'hr';
const MAX_SCAN   = 4000;   // rows read when looking up "last session"

const HEADERS = [
  'timestamp', 'date', 'user', 'session', 'exercise',
  'set', 'weight_kg', 'reps', 'rir', 'notes', 'batch_id',
  'set_ts', 'hr_avg', 'hr_peak'
];

const HR_HEADERS = [
  'timestamp', 'date', 'user', 'session', 'source',
  'start', 'end', 'duration_min', 'avg_hr', 'max_hr', 'pct_max', 'min_above_80',
  'z1_min', 'z2_min', 'z3_min', 'z4_min', 'z5_min', 'samples', 'series_10s'
];

/* ── read: last session per exercise ─────────────────────────────── */

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (p.secret !== SECRET) return json({ ok: false, error: 'unauthorized' });
    if (p.action !== 'last') return json({ ok: false, error: 'unknown action' });

    const user = String(p.user || '');
    const sh = getSheet(SHEET_NAME, HEADERS);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return json({ ok: true, last: {} });

    const start = Math.max(2, lastRow - MAX_SCAN + 1);
    const vals = sh.getRange(start, 1, lastRow - start + 1, HEADERS.length).getValues();

    // Walk backwards. The first time an exercise appears, that date is its most
    // recent session; keep only rows carrying the same date.
    const last = {};
    for (let i = vals.length - 1; i >= 0; i--) {
      const r = vals[i];
      if (String(r[2]) !== user) continue;
      const ex = String(r[4]);
      if (!ex) continue;
      const date = String(r[1]);
      if (!last[ex]) last[ex] = { date: date, sets: [] };
      if (last[ex].date !== date) continue;
      last[ex].sets.unshift({ w: cell(r[6]), r: cell(r[7]), rir: cell(r[8]) });
    }
    return json({ ok: true, last: last });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ── write: one row per set, plus one heart rate row ─────────────── */

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return json({ ok: false, error: 'unauthorized' });

    const rows = body.rows || [];
    const hr = body.hr || null;
    if (!rows.length && !hr) return json({ ok: false, error: 'nothing to write' });

    const sh = getSheet(SHEET_NAME, HEADERS);
    const batchId = String(body.batchId || '');

    // A session queued offline and retried must not write twice.
    if (batchId && batchSeen(sh, batchId)) {
      return json({ ok: true, written: 0, duplicate: true });
    }

    const now = new Date();

    if (rows.length) {
      const values = rows.map(function (r) {
        return [
          now,
          String(r.date || ''),
          String(r.user || ''),
          String(r.session || ''),
          String(r.exercise || ''),
          num(r.set),
          num(r.weight),
          num(r.reps),
          num(r.rir),
          String(r.notes || ''),
          batchId,
          String(r.set_ts || ''),
          num(r.hr_avg),
          num(r.hr_peak)
        ];
      });
      sh.getRange(sh.getLastRow() + 1, 1, values.length, HEADERS.length).setValues(values);
    }

    if (hr) {
      const hsh = getSheet(HR_SHEET, HR_HEADERS);
      hsh.appendRow([
        now,
        String(hr.date || ''),
        String(hr.user || ''),
        String(hr.session || ''),
        String(hr.source || ''),
        String(hr.start || ''),
        String(hr.end || ''),
        num(hr.duration_min),
        num(hr.avg_hr),
        num(hr.max_hr),
        num(hr.pct_max),
        num(hr.min_above_80),
        num(hr.z1), num(hr.z2), num(hr.z3), num(hr.z4), num(hr.z5),
        num(hr.samples),
        String(hr.series_10s || '').slice(0, 45000)   // cell limit is 50k characters
      ]);
    }

    return json({ ok: true, written: rows.length, hr: !!hr });

  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ── helpers ─────────────────────────────────────────────────────── */

/** Creates the tab if missing, and appends any headers added since. */
function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);

  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sh;
  }

  const width = sh.getLastColumn();
  if (width < headers.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function batchSeen(sh, batchId) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  const start = Math.max(2, lastRow - 500 + 1);
  const col = sh.getRange(start, 11, lastRow - start + 1, 1).getValues();   // batch_id column
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0]) === batchId) return true;
  }
  return false;
}

function cell(v) {
  return (v === '' || v === null || v === undefined) ? '' : String(v);
}

function num(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(String(v).replace(',', '.'));
  return isNaN(n) ? String(v) : n;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
