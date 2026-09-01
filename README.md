# Logbook

Workout logging for two people, writing to one Google Sheet. Static site, no build step, no server.

## Setup, about 20 minutes

The backend runs on Cloudflare, not Google Apps Script. Google's Advanced Protection Program blocks Apps Script from authorising at all, and the only official fix is turning Advanced Protection off, which is not worth it. Cloudflare needs no Google account, gives real success and failure responses, and keeps the secret on the server instead of in this public repo.

**1. Cloudflare account.** Sign up at dash.cloudflare.com with any email. No card, no domain.

**2. Database.** In the sidebar: Storage & Databases ▸ D1 ▸ Create. Name it `workoutlog`. Leave it empty — the Worker builds its own tables the first time it runs.

**3. Worker.** Compute ▸ Workers & Pages ▸ Create ▸ Start from Hello World ▸ Deploy. Then connect it to this repository as described under Deploying, and every later change arrives on its own.

**4. Wire the Worker to the database and the secret.** On the Worker: Settings ▸ Bindings ▸ Add.

   - D1 database — variable name `DB`, pointing at `logbook`.
   - Secret (plain text) — variable name `LOGBOOK_SECRET`, value anything you like, for example `logbook-4f9c2e`. Keep a copy.

   Redeploy after adding bindings.

**5. Front end.** Copy the Worker URL, something like `https://logbook.yourname.workers.dev`. In `index.html`, lines 12 and 13:

```js
const ENDPOINT = 'https://logbook.yourname.workers.dev';
const SECRET   = 'the same string you set as LOGBOOK_SECRET';
```

Commit. GitHub Pages republishes in about a minute.

**6. Phone.** Open the Pages URL. The orange "Not connected yet" box should be gone. Share ▸ Add to Home Screen.

**7. Test.** Log one set and save. The status line should say it saved — not "held on this device". Confirm in D1 ▸ Console with `SELECT * FROM sets;`.

## Deploying

`index.html`, `README.md` and `schema.sql` deploy themselves: GitHub Pages republishes about a minute after a push to `main`.

`worker.js` does too, once. Connect it in the Cloudflare dashboard one time and never open it again:

1. Put the real database id into `wrangler.toml`. D1 ▸ `workoutlog` ▸ Settings shows it. It is an identifier, not a credential, and belongs in the repository.
2. Workers & Pages ▸ `wild-haze-fac9` ▸ Settings ▸ Build ▸ **Connect** to `Ikarus-eth/OperationLean`, branch `main`, root `/`.
3. Leave the build command empty. Deploy command `npx wrangler deploy`.

After that a push updates the Worker the way it already updates the app.

Two things to know before connecting. `wrangler.toml` becomes the source of truth for bindings, so a binding missing from it is dropped on the next deploy — the D1 binding is in there, keep it there. And `LOGBOOK_SECRET` must stay a dashboard secret and must never go into `wrangler.toml`, because this repository is public. Secrets survive deploys; they are managed separately from the config.

If the database id is still a placeholder the build fails and the running Worker is left alone, which is the safe way round.

### The database migrates itself

There is no SQL to run, ever. On its first request after a deploy the Worker creates any missing table and adds any missing column, so an empty D1 database becomes a working one on its own.

Each statement runs separately on purpose. A batch is a single transaction, so one `duplicate column name` aborts everything after it — which is exactly what happens when these are pasted into the D1 console as one block and half of them silently never run.

Adding a column means adding it to `SCHEMA_COLUMNS` in `worker.js`, and to `schema.sql` so the file still describes reality. Nothing else.

Open the Worker URL to see where things stand: `schema` says `ok`, `columns` lists what each table actually has, and `ready` is true only when the code and the database agree.

## Getting it into a Google Sheet

The Worker serves the whole log as CSV. In any Google Sheet, one formula pulls it in and keeps it current:

```
=IMPORTDATA("https://logbook.yourname.workers.dev/?action=csv")
```

For the heart rate table, add `&table=hr`.

`IMPORTDATA` is a built-in sheet function, not a connected app, so Advanced Protection doesn't block it. It refreshes roughly hourly, or on demand from the sheet.

Reads need no secret. You can open that URL in any browser, hand it to anyone, or point a second sheet at it. Writes still need the secret — not to keep the log private, but so nobody can add junk rows and poison the values the app carries over each week.

## Logging a session

Every field arrives pre-filled with what you did last time — weight, reps and RIR.

- **Same as last week:** tap the tick. One tap for the whole set.
- **Something changed:** edit the field. Editing ticks the set for you.
- **Didn't do it:** leave it alone. Unticked sets are not saved.

Pre-filled values are grey. Once a set is ticked they turn black, so a glance tells you how far through the session you are. When a field differs from last week, the old number appears underneath it. A green edge on the weight box means `weight × reps` beat that set number last time. Where an exercise has no weight box, reps alone decide.

The tick is not decoration — it timestamps the set, which is what makes per-exercise heart rate possible.

### It saves itself

There is no submit step. Every tick and every typed number is written to the server about a second later, and the button at the bottom says where things stand:

| Button | Meaning |
|---|---|
| Tick the sets you did | nothing logged yet |
| Saving in a moment… | a change is queued |
| Saving… | uploading now |
| **Saved · 7 sets** (green) | on the server, with the time underneath |
| **Not saved — tap to retry** (amber) | no connection; held on the device, sent when it comes back |

Typing a weight or a rep count confirms that set on its own, so an edited row does not also need a tap. The tap is for a set you did exactly as prefilled.

A save replaces the stored version of that person, date and session rather than adding to it. So the same screen can be sent a hundred times without piling up duplicates, and unticking a set removes it from the database. The screen is the record.

Open the same date on another device and the sets come back ticked, because the app now asks the server what it already has for that day. That is also why a session logged on the laptop shows up on the phone — but only after you set the phone to the same date. The app always opens on today.

If two devices have the same session open at once, the last one to save wins. Log on one at a time.

The app checks the worker before it sends anything. If the worker is older than the app the button turns red and says so, and nothing is written — an older worker would take each save as a fresh append, once a second, with nothing to deduplicate on. Whatever was ticked is held and goes up once they match.

### Comments

Every exercise has a comment box under its buttons. It is for that exercise on that day — cue that worked, pain, tempo, which machine. It is saved on every set row of that exercise, in the `ex_notes` column, next to the session-wide `notes`. Comments do not carry over; they describe a day, not a habit.

### Changing what is on the screen

The **×** beside an exercise name removes it for today. Nothing is lost that was going to be saved — untapped sets were never going to be written — but it clears the screen when the rack is taken or a machine is broken, and stops a stale prefill tempting a wrong tick. If anything in the block was ticked or edited it asks first.

**Add an exercise** at the bottom adds one. Type the name of something you removed and it comes back with its target, hint and unit labels intact. Type anything else and you get a plain three-row block, which carries over next week like everything else.

Both are for today only, and both are local to the device. Another device opening the same date shows the full program again, with the removed exercise back but empty and unticked — nothing was logged for it, so nothing is wrong, it is just clutter you have to clear twice. Next session the program is back as written everywhere.

### Every day

Under every session, training day or rest day, there is an **Every day** block:

- **Pulls**, three sets, four reps. Adjust the reps, tick the sets you did.
- **Handstand**, one row, ten minutes. Tick it only if you practised ten minutes or more.

These open at the prescription every day, not at what you did last time — that is the point of a target. They are the same rows whichever session is picked in the dropdown, so switching sessions after ticking them cannot log them twice.

They write against session `Daily`, so they never inflate a session's volume. `SELECT * FROM sets WHERE session = 'Daily'` is the whole habit log.

### Pull-ups

Three boxes instead of the usual three: **BW reps**, **assisted**, **assist kg**. Do as many bodyweight reps as you have, then finish to ten on the assist machine and record how much counterweight it took.

The ladder opens at 8/2, 7/3, 6/4 the first time and carries over from what you actually did after that. `assisted` is stored in its own column, `reps_assist`, so bodyweight reps and machine reps never get added together by accident.

Progress here is bodyweight reps, not weight — more counterweight is less work, so the usual weight-times-reps comparison would mark going backwards as a green edge. The exercise says `progress: 'r'` and the comparison follows it.

The every-day **Pulls** item does not appear on Upper A or Upper B, since those sessions have pull-ups in them already. That is the `except` list on the item.

### Units

The first box is kilograms unless the exercise says otherwise. Jumps is inches: box height goes in the first box, reps in the second. The number is stored in the same `weight` column as everything else — the unit is a property of the exercise name, not of the row, so nothing about the table changes. Set `units: { w: 'in' }` on an exercise to relabel it, `fields: ['r']` to drop boxes it does not need.

## Logging a session for an earlier day

The date at the top right is editable. Tap it, pick a day, and everything on the screen belongs to that day: its own draft, its own carry-over, its own rows in the table. Today's half-finished session is parked, not lost, and comes back when you tap **Back to today**. Future dates are blocked.

Changing the date also switches the session to whatever that weekday usually is, unless you already picked one from the dropdown yourself.

One thing does not move. A tick records the moment you tapped it, which is real information — it is how a retrospective entry stays visible in the data rather than looking like it was logged live. It also means per-set heart rate cannot line up for a back-dated session, because the timestamps fall on the wrong day. `hr_avg` and `hr_peak` come out blank on those rows. The workout summary in the `hr` table still saves in full, dated to the session.

## Logging from more than one device

Saved sessions are on the server, so both the phone and the laptop see the same history and the same carry-over.

A session in progress is not. Drafts and the day's every-day ticks live in the browser's local storage on the device you typed them on. Nothing syncs until you press Save.

- **Fine:** log on the phone, then open the laptop on the same date. The sets come back ticked.
- **Fine:** tick half a session on the phone and finish it on the laptop, as long as the phone finished uploading first. Watch for the green button before you switch.
- **Fine:** tick Pulls on both. A save replaces rather than appends, so it stays one set of rows rather than two.
- **Not fine:** both devices open on the same date at once. Neither knows about the other and the last save wins, silently.

Two things still live only on the device you typed them on: an unsent change made offline, and the heart rate file you attached by hand. Everything else is on the server the moment the button turns green.

## Heart rate

Apple can't export a single workout on its own. The built-in "Export All Health Data" gives you one XML dump of your entire history, which is useless here. You need one app on the phone:

- **Health Auto Export** — free to install. Exporting workouts with heart rate is a Basic feature, a one-time purchase. Premium adds automatic background exports and is not needed. There is a seven-day trial of everything.
- **HealthFit** — one-time purchase, exports per workout as FIT, TCX, GPX or CSV.

Either works. The app reads **CSV, TCX, GPX and JSON**. FIT is binary and is not supported.

### Automatic, the way it normally runs

The phone pushes finished workouts to the Worker on its own. You tick sets in the gym and press Save; the trace turns up later and the server matches it to the sets by timestamp. Nothing to export, nothing to attach.

**Setting it up, once per phone.** Health Auto Export, Premium tier — automatic export to an outside service is the Premium feature; Basic only does manual exports. Then Automations ▸ New Automation ▸ REST API:

| Field | Value |
|---|---|
| URL | `https://wild-haze-fac9.74vshck6t7.workers.dev/?user=ikarus` |
| HTTP header | `X-Logbook-Secret` : the same string as `LOGBOOK_SECRET` |
| Data Type | Workouts |
| Include Workout Metrics | on |
| Include Route Data | off |
| Time Grouping | Seconds |
| Export Format | JSON |
| Export Version | 2 |
| Date Range | Since Last Sync |
| Batch Requests | on |
| Sync Cadence | every 1 hour |

Johanna's phone gets the same thing with `?user=johanna`. That query parameter is the only thing telling the Worker whose heart it is, so it has to be right.

Use **Manual Export** in the automation screen to test it before trusting it. A good response looks like `{"ok":true,"seen":3,"written":1,"skipped":2,"attributed":14}`. Activity Logs in the same screen show every run.

**What "automatic" actually means.** Apple does not let any app read health data while the phone is locked, and background runs depend on Background App Refresh. So the push happens the next time the phone is unlocked and iOS gives the app a slot — usually minutes after you pick it up, not the instant the workout ends. Adding the Health Auto Export widget to the home screen improves how often background runs succeed. Charging helps too. Nothing here is lost by waiting: the server re-matches the whole day every time either half arrives.

**What gets stored.** Every workout of ten minutes or more, not only gym sessions — surfing, runs, walks long enough to count. `workout_type` holds what the watch called it, so filter on that. Shorter workouts and any workout with no heart rate trace are dropped. The same workout arriving again, which happens on every sync, updates its row instead of adding one.

**Turn it off** by deleting the automation. The manual path below keeps working.

### Why this needs an outside app at all

A web page cannot read Apple Health. There is no browser API for HealthKit and there is not going to be one: Apple exposes health data only to native apps carrying the HealthKit entitlement. Logbook is a web page on GitHub Pages, so it can never reach the watch by itself, however the app is written.

Getting there directly would mean shipping a native iOS app, which costs $99 a year for the Apple Developer Program. Without paying, a sideloaded build expires after seven days and has to be reinstalled from Xcode. That is worse than a one-time purchase on every axis.

So the choice is which entitled app does the reading. Two work.

### Option A — Health Auto Export, $24.99 lifetime

Set up as above. Buy it if you want this to run for years without attention: it handles since-last-sync bookkeeping, retries, background scheduling within iOS's limits, and keeps activity logs when a run fails. That reliability is the actual product; the export is the easy part.

### Option B — an iOS Shortcut, free

Shortcuts is Apple's own app and carries the HealthKit entitlement, so it can read heart rate directly and POST it. The Worker accepts a deliberately plain payload so a Shortcut can build one without loops:

```
POST https://wild-haze-fac9.74vshck6t7.workers.dev/?user=ikarus
Header: X-Logbook-Secret: <LOGBOOK_SECRET>

{ "name":  "Strength",
  "day":   "2026-09-01",
  "start": "2026-09-01 09:00:00 +0800",
  "end":   "2026-09-01 09:45:00 +0800",
  "values": "112,118,125,131, …" }
```

`values` is one comma-separated string of bpm. `times` is optional; leave it out and the values are spread evenly between start and end, which is right for a steady sampling rate. Send `day`, or put the UTC offset in `start` — a 07:00 session in Bali is the previous calendar day in UTC, and the row would land on the wrong date.

Roughly, the shortcut is: **Find Workouts** (most recent, limit 1) → **Get Details** for start and end → **Find Health Samples** (Heart Rate, between those two) → **Get Details** of Value → **Combine Text** with a comma → **Text** to assemble the JSON → **Get Contents of URL**, POST, with the header. Drive it from a personal automation on the Workout trigger, set to run without asking.

The catch is that this has not been tested here, only the endpoint it posts to. Whether the detail actions map cleanly over a list of several hundred samples, and how reliably a workout-triggered automation fires, are things only your phone can answer. Shortcuts automations also fail silently. Try it before spending; fall back to Option A if it fights you.

Both hit the same wall regardless: Apple blocks health reads on a locked phone, so either way the push happens the next time you unlock it.

Test either with curl before wiring anything up:

```
curl -X POST 'https://wild-haze-fac9.74vshck6t7.workers.dev/?user=ikarus' \
  -H 'X-Logbook-Secret: <LOGBOOK_SECRET>' -H 'Content-Type: application/json' \
  -d '{"name":"Test","day":"2026-09-01","start":"2026-09-01 09:00:00 +0800",
       "end":"2026-09-01 09:30:00 +0800","values":"120,130,140,150,145,135"}'
```

### Manual, as a fallback

1. Finish the workout on the watch so it closes and lands in Health.
2. Open the export app on the phone and find that workout by date.
3. Export it as **CSV or JSON**, with heart rate included, at the **finest resolution the app offers**. In Health Auto Export the aggregation control is the thing to watch: anything coarser than seconds gives you one averaged number for the whole session, which produces a flat line and no per-set values.
4. Save it to Files, or use the share sheet.
5. In Logbook, tap **Choose a workout file** and pick it. The summary appears immediately: duration, average, peak, peak as a percentage of your max, minutes above 80%, and the zone bar. A peak bpm shows up beside each ticked set.
6. Press Save. The sets and the workout go up together.

You can attach the file before or after ticking the sets; the per-set numbers recalculate either way. To swap files, press **Remove this file** and pick another. The file rides along in the draft, so closing the tab does not lose it.

If the export fails or arrives empty, try JSON instead of CSV — the CSV generator in Health Auto Export has drawn complaints recently. [S]

### Heart rate on its own

You do not need to tick any sets. Attach a file and the button reads **Save heart rate only**. That is the way to log a run, a swim, or a session you logged on paper.

### What it can and can't tell you

You get duration, average, peak, peak as a percentage of your max, minutes above 80%, and a zone breakdown. Zones are cut at 60/70/80/90% of the `MAX_HR` value for that person at the top of `index.html`. Those are set to 182 and 185. If they are wrong, every zone number is wrong; measure or estimate and change them.

`series_10s` holds the whole trace at ten-second resolution in one cell, so the shape of the curve survives into the sheet without several thousand rows per session.

**How per-set heart rate is worked out, and its limits.** For each ticked set, the highest bpm in the 90 seconds before you tapped the tick. That assumes you tick shortly after racking the weight. Tick late and the number drifts toward rest heart rate; tick a batch of sets at the end and the numbers are meaningless. Treat it as a good indicator of which exercises drive heart rate, not as a precise measurement.

**The matching happens on the server, not in the browser.** It has to: the watch data arrives long after the browser has gone. Every write — sets or heart rate, in either order — re-matches that whole day. So logging the session first and letting the trace turn up an hour later gives the same result as attaching a file by hand, and forgetting to attach a file costs nothing.

The numbers are read back out of `series_10s`, which holds the peak of each ten-second bucket. The peak is therefore exact and the per-set average is a mean of about nine bucket peaks, a few bpm high. It is the same method whichever way the trace arrived, which is worth more than the last bpm of accuracy.

It needs the ticks and the trace to be on the same day, which is why a back-dated session gets a workout summary but no per-set numbers.

**Three constants live in two files.** `MAX_HR`, `SET_WINDOW_S` and the ten-minute workout floor are in `index.html` for the live display and in `worker.js` for the stored values. Change both together or the screen and the database will disagree.

## Changing the program

Edit the `PROGRAM` object in `index.html`. Nothing else changes — not the sheet, not the script.

```js
{ name: 'Belt Squat', target: '3 × 8-12', sets: 3, hint: 'optional note', pair: 'A' }
```

- `sets` is only how many rows appear. Add or remove more in the app.
- `pair` draws the bracket linking antagonist supersets. Omit for unpaired work.
- `units: { w: 'in' }` relabels a box. `fields: ['r']` shows only that box.
- `fixed: { r: '4' }` opens the row at that value every time and ignores what you did last time. For prescriptions, not for progression.
- `seed: [{ r:'8' }, { r:'7' }]` is a per-set starting point for an exercise with no history yet. Unlike `fixed` it steps out of the way as soon as there is a real session to carry over from.
- `progress: 'r'` names the number that decides whether a set beat last week. Without it the comparison is weight times reps, which is wrong wherever more weight means less work.
- `except: ['Upper A']` on an every-day item keeps it off sessions that already cover it.
- Anything not in the program can still be logged with "Add an exercise", and it carries over next week like everything else.

The `DAILY` object below `PROGRAM` holds the every-day items, same shape.

Renaming an exercise starts its history over — carry-over is keyed on the exact name, and the old rows keep the old name. Change a name only when you mean to break the line.

Johanna's program in the config is a placeholder, and she has no daily items yet. Replace both.

## How the data is stored

`batch_id` is `sync` on anything written by the app now. The old random value only appears on rows from before continuous saving.

**`sets` table** — one row per set:

| id | ts | date | user | session | exercise | set_no | weight | reps | reps_assist | rir | notes | ex_notes | batch_id | set_ts | hr_avg | hr_peak |

`session` is the split name, or `Daily` for the every-day items. `weight` is kilograms except where the exercise says otherwise — inches for Jumps, counterweight on the assist machine for pull-ups, and blank for anything with no weight box. `reps` is bodyweight reps and `reps_assist` the ones finished on the machine; everywhere else `reps_assist` is empty. `notes` is the session note repeated on every row; `ex_notes` is the comment on that one exercise.

**`hr` table** — one row per workout: duration, average, max, percentage of max, minutes above 80%, minutes in each of five zones, and `series_10s`, the whole trace at ten-second resolution in a single cell. Storing every sample as its own row would add several thousand rows per session; ten-second buckets keep the shape of the curve without that.

`source` says where the row came from: a filename for a hand-attached export, `watch:<name>` for one the phone pushed. `workout_type` is what the watch called the activity. `session` is blank on a workout that arrived before its sets and is filled in when they land.

Long format, not wide. This is why program changes are free: a new exercise is a new *value* in the `exercise` column, never a new column. A wide table would need a migration every time the block changes, and would break every query built on top of it.

For analysis, pivot on `exercise` and `date`. Volume per set is `weight_kg × reps`.

## Behaviour worth knowing

- **Offline.** Gym wifi drops. A failed save is held on the device and goes up on the next save or when the connection returns. `batch_id` stops a retry from writing twice.
- **Drafts.** A part-finished session survives closing the tab, including an attached heart rate file. Keyed by person, session and date. Every-day items are kept separately, keyed by person and date only, so they follow you across the session dropdown. The draft is now a cache in front of the server rather than the only copy.
- **Drafts follow the program.** A draft holds what you typed. Targets, hints, unit labels and which boxes appear are rebuilt from `PROGRAM` every time the page loads, so editing the program takes effect on an open draft instead of waiting for midnight. Set counts are not: if you removed a set, it stays removed. An exercise you added to the program today appears in the draft; one you deleted with the **×** stays deleted.
- **Wrong date on a heart rate file** shows a warning but still saves against today.

## The write secret is in this repository

`SECRET` on line 15 of `index.html` is the same string as `LOGBOOK_SECRET`, and this repository is public. Anyone who finds it can write to the database.

That was a small problem when writes only appended. It is a larger one now that a save replaces a day: a single crafted request can empty a session rather than just add junk to it.

Two ways out, neither started:

- **Take it out of the repository.** The app already has a setup panel and knows when it is unconfigured. The secret would be typed once per browser and kept in local storage instead of committed. Four one-time entries across two people and two devices each, and the hole closes.
- **Leave it and rely on recovery.** D1 Time Travel keeps thirty days of point-in-time restore, in the dashboard next to the Console tab. Nothing is unrecoverable within a month.

The second is fine if nobody is looking for this repository. The first is what to do if that stops being true.

## Two things this does not do

**The log is public by design.** Reads are open — anyone with the Worker URL can pull the whole log. That was a deliberate call: it's training data, and nothing here can reach any other account.

**The write secret is weak.** GitHub Pages serves `index.html` publicly, so anyone who finds it can read `SECRET` and write rows. It stops drive-by junk, nothing more. The real defence is that a bad write is visible and deletable with one SQL statement. If it ever became a problem, the fix is a login in front of the Worker, at the cost of a sign-in on every phone.

**No editing past sessions.** Corrections happen with SQL in the D1 console. An edit UI needs row lookup, update and delete paths in the script, which is not worth it for something that happens rarely.

## If it stops working

- **"Held on this device" instead of "Saved".** The Worker rejected the request or wasn't reachable. Open the Worker URL with `?action=last&user=ikarus` in a browser: `unauthorized` means the secret in `index.html` doesn't match `LOGBOOK_SECRET`, and a 500 usually means the `DB` binding is missing or you forgot to redeploy after adding bindings.
- **Carried-over values are empty but saving works.** The `sets` table exists but the read query found nothing for that user. Check the `user` column values with `SELECT DISTINCT user FROM sets;`.
- **"No heart rate values in that file."** The export didn't include heart rate, or it's a FIT file. Re-export as CSV or TCX with heart rate enabled.
- **Every save is held on the device after a Worker update.** Open the Worker URL. If `schema` is not `ok` the migration could not run — the message says why. If `ready` is false but `schema` is `ok`, the secret or the D1 binding is missing.
- **"Saved, but assisted reps are being dropped."** The worker predates the `reps_assist` column. Everything else is saving normally. Deploy `worker.js` and it stops.
- **The button is red and says the worker is out of date.** The app on this device is newer than the worker it is talking to. Deploy `worker.js`. Nothing is lost: everything ticked is held and uploads once they match. `?action=day` returning `unknown action` is the same cause.
- **A Cloudflare build fails.** Check `database_id` in `wrangler.toml` against D1 ▸ `workoutlog` ▸ Settings. The Worker that was already running keeps running.
- **The watch automation returns 401.** The `X-Logbook-Secret` header does not match `LOGBOOK_SECRET`.
- **It returns 400 asking for a user.** `?user=ikarus` is missing from the automation URL.
- **`{"ok":true,"written":0,"skipped":2}`.** It ran, found workouts, and dropped them: either under ten minutes or with no heart rate trace. Check that Include Workout Metrics is on and Time Grouping is Seconds.
- **Nothing arrives for hours.** Expected if the phone stays locked; Apple blocks health reads on a locked device. Check Activity Logs in the automation screen, add the widget to the home screen, and confirm Background App Refresh is on for the app.
- **A session logged on one device is missing on another.** Check the date at the top: the app opens on today, and a session logged for an earlier day is only visible with that day selected. If the date is right, open `?action=csv&table=sets` and search for it — if the rows are there the read-back failed, if they are not the save never landed and the first device is probably still showing an amber button.
- **Heart rate rows appear but per-set columns stay empty.** The ticks and the trace are on different days, or the set timestamps fall outside every workout window. Compare `sets.set_ts` with `hr.start` and `hr.finish`.
