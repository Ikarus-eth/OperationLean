/* Builds routines.json, the program as Hevy routine bodies, for the
   Worker's ?action=hevy-sync. Run after any program change:

     node tools/build-routines.js

   It uses the same code as hevy-routines.html, reading the program out
   of index.html and the names out of hevy.html, so the page and the
   Worker always write the same routines. Weights and Hevy's exercise ids
   are not in the file: the Worker adds them at sync time from the log
   and from Hevy. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const scripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

const pure = scripts(read('hevy-routines.html')).find(b => b.includes('function buildRoutines'));
const mod = { exports: {} };
new Function('module', pure)(mod);
const { buildRoutines, hevyTypeOf } = mod.exports;

const progBlock = scripts(read('index.html')).find(b => b.includes('const SESSIONS_IKARUS'));
const { PROGRAM, EX_CFG } = new Function(progBlock + '\nreturn { PROGRAM, EX_CFG };')();
const HEVY = new Function(/const HEVY = \{[\s\S]*?\n\};/.exec(read('hevy.html'))[0] + '\nreturn HEVY;')();

/* The every-day pulls belong in Hevy too, or they go unlogged on the
   watch: at the end of both lower days (the upper days have pull-ups),
   and as a routine of their own for Wednesday, Saturday and Sunday.
   Handstand is left out while the toe keeps it off the program. */
const DAILY_PULLS = { name: 'Pulls', target: '3 × 4', sets: 3, fields: ['r'], fixed: { r: '4' } };
for (const user of Object.keys(PROGRAM)) {
  const s = PROGRAM[user].sessions;
  ['Lower 1', 'Lower 2'].forEach(k => { if (s[k] && !s[k].some(l => l.name === 'Pulls')) s[k] = s[k].concat([DAILY_PULLS]); });
  s['Pulls'] = [DAILY_PULLS];
}

const out = { built: new Date().toISOString(), users: {} };
for (const user of Object.keys(PROGRAM)) {
  out.users[user] = buildRoutines(PROGRAM, EX_CFG, HEVY, user, {}, () => null, false).map(rt => ({
    title: rt.title,
    notes: rt.notes,
    exercises: rt.exercises.map(x => ({
      name: x.name,
      hevy: x.hevyName,
      type: hevyTypeOf(x.cfg),
      timedUnit: (x.cfg.units || {}).r === 'min' ? 'min' : 'sec',
      custom: mod.exports.customBody ? mod.exports.customBody(x.name, x.hevyName, x.cfg) : null,
      body: x.body,
    })),
  }));
}
/* Hevy title → Logbook name, for reading workouts back. A person's own
   program names win, so the incline sled comes back as Incline Leg Press;
   the rest of the HEVY table fills in, first name kept where two Logbook
   names share one Hevy exercise. */
out.names = {};
for (const user of Object.keys(out.users)) {
  const own = {};
  out.users[user].forEach(rt => rt.exercises.forEach(x => { own[x.hevy] = own[x.hevy] || x.name; }));
  const all = {};
  Object.entries(HEVY).forEach(([log, hevy]) => { if (!(hevy in all)) all[hevy] = log; });
  out.names[user] = { ...all, ...own };
}

fs.writeFileSync(path.join(root, 'routines.json'), JSON.stringify(out, null, 1) + '\n');
console.log('routines.json:', Object.entries(out.users).map(([u, r]) => u + ' ' + r.length + ' routines').join(', '));
