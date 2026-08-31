# Logbook

Workout logging for two people, writing to one Google Sheet. Static site, no build step, no server.

## Setup, about 20 minutes

The backend runs on Cloudflare, not Google Apps Script. Google's Advanced Protection Program blocks Apps Script from authorising at all, and the only official fix is turning Advanced Protection off, which is not worth it. Cloudflare needs no Google account, gives real success and failure responses, and keeps the secret on the server instead of in this public repo.

**1. Cloudflare account.** Sign up at dash.cloudflare.com with any email. No card, no domain.

**2. Database.** In the sidebar: Storage & Databases ▸ D1 ▸ Create. Name it `logbook`. Open it, go to the Console tab, paste in everything from `schema.sql`, and Execute. Two tables appear, `sets` and `hr`.

**3. Worker.** Compute ▸ Workers & Pages ▸ Create ▸ Start from Hello World ▸ Deploy. Then Edit code, delete what's there, paste in `worker.js`, and Deploy again.

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

Pre-filled values are grey. Once a set is ticked they turn black, so a glance tells you how far through the session you are. When a field differs from last week, the old number appears underneath it. A green edge on the weight box means `weight × reps` beat that set number last time.

The tick is not decoration — it timestamps the set, which is what makes per-exercise heart rate possible.

## Heart rate

Apple can't export a single workout on its own. You need one app on the phone:

- **Health Auto Export** — free to install, Basic tier is a one-time purchase and covers exporting workouts with heart rate as CSV or JSON. Premium adds automatic exports.
- **HealthFit** — one-time purchase, exports per workout as FIT, TCX, GPX or CSV.

Either works. After the session, export the workout and pick the file in the app. It reads **CSV, TCX, GPX and JSON**; FIT is binary and is not supported.

You get duration, average, peak, peak as a percentage of your max, minutes above 80%, and a zone breakdown. Each ticked set also gets a peak bpm shown beside it.

**How per-set heart rate is worked out, and its limits.** For each ticked set, the app takes the highest bpm in the 90 seconds before you tapped the tick. That assumes you tick shortly after racking the weight. Tick late and the number drifts toward rest heart rate; tick a batch of sets at the end and the numbers are meaningless. Treat it as a good indicator of which exercises drive heart rate, not as a precise measurement. Change `SET_WINDOW_S` if your habit differs.

## Changing the program

Edit the `PROGRAM` object in `index.html`. Nothing else changes — not the sheet, not the script.

```js
{ name: 'Belt Squat', target: '3 × 8-12', sets: 3, hint: 'optional note', pair: 'A' }
```

- `sets` is only how many rows appear. Add or remove more in the app.
- `pair` draws the bracket linking antagonist supersets. Omit for unpaired work.
- Anything not in the program can still be logged with "Add an exercise", and it carries over next week like everything else.

Johanna's program in the config is a placeholder. Replace it.

## How the data is stored

**`sets` table** — one row per set:

| id | ts | date | user | session | exercise | set_no | weight | reps | rir | notes | batch_id | set_ts | hr_avg | hr_peak |

**`hr` table** — one row per workout: duration, average, max, percentage of max, minutes above 80%, minutes in each of five zones, and `series_10s`, the whole trace at ten-second resolution in a single cell. Storing every sample as its own row would add several thousand rows per session; ten-second buckets keep the shape of the curve without that.

Long format, not wide. This is why program changes are free: a new exercise is a new *value* in the `exercise` column, never a new column. A wide table would need a migration every time the block changes, and would break every query built on top of it.

For analysis, pivot on `exercise` and `date`. Volume per set is `weight_kg × reps`.

## Behaviour worth knowing

- **Offline.** Gym wifi drops. A failed save is held on the device and goes up on the next save or when the connection returns. `batch_id` stops a retry from writing twice.
- **Drafts.** A part-finished session survives closing the tab, including an attached heart rate file. Keyed by person, session and date.
- **Wrong date on a heart rate file** shows a warning but still saves against today.

## Two things this does not do

**The log is public by design.** Reads are open — anyone with the Worker URL can pull the whole log. That was a deliberate call: it's training data, and nothing here can reach any other account.

**The write secret is weak.** GitHub Pages serves `index.html` publicly, so anyone who finds it can read `SECRET` and write rows. It stops drive-by junk, nothing more. The real defence is that a bad write is visible and deletable with one SQL statement. If it ever became a problem, the fix is a login in front of the Worker, at the cost of a sign-in on every phone.

**No editing past sessions.** Corrections happen with SQL in the D1 console. An edit UI needs row lookup, update and delete paths in the script, which is not worth it for something that happens rarely.

## If it stops working

- **"Held on this device" instead of "Saved".** The Worker rejected the request or wasn't reachable. Open the Worker URL with `?action=last&user=ikarus` in a browser: `unauthorized` means the secret in `index.html` doesn't match `LOGBOOK_SECRET`, and a 500 usually means the `DB` binding is missing or you forgot to redeploy after adding bindings.
- **Carried-over values are empty but saving works.** The `sets` table exists but the read query found nothing for that user. Check the `user` column values with `SELECT DISTINCT user FROM sets;`.
- **"No heart rate values in that file."** The export didn't include heart rate, or it's a FIT file. Re-export as CSV or TCX with heart rate enabled.
