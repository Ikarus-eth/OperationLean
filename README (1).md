# Logbook

Workout logging for two people, writing to one Google Sheet. Static site, no build step, no server.

## Setup, about 10 minutes

**1. Sheet.** Create a new Google Sheet. Leave it empty — the script creates its tabs and headers on first write.

**2. Backend.** In that sheet: `Extensions ▸ Apps Script`. Delete the placeholder, paste in `Code.gs`, change `SECRET`, save.

`Deploy ▸ New deployment ▸ Web app`:

- Execute as: **Me**
- Who has access: **Anyone**

Authorise when prompted. Google warns that the app is unverified — expected for your own script; continue through the advanced link. Copy the `/exec` URL.

**3. Front end.** In `index.html`, near the top:

```js
const ENDPOINT = 'https://script.google.com/macros/s/.../exec';
const SECRET   = 'the same string you put in Code.gs';
const MAX_HR   = { ikarus: 182, johanna: 185 };
```

**4. Deploy.** Push to a GitHub repo, then `Settings ▸ Pages ▸ Source: main branch`. On your phone, open it and use "Add to Home Screen".

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

**`log` tab** — one row per set:

| timestamp | date | user | session | exercise | set | weight_kg | reps | rir | notes | batch_id | set_ts | hr_avg | hr_peak |

**`hr` tab** — one row per workout: duration, average, max, percentage of max, minutes above 80%, minutes in each of five zones, and `series_10s`, the whole trace at ten-second resolution in a single cell. Storing every sample as its own row would add several thousand rows per session; ten-second buckets keep the shape of the curve without that.

Long format, not wide. This is why program changes are free: a new exercise is a new *value* in the `exercise` column, never a new column. A wide sheet would need restructuring every time the block changes, and would break every formula built on top of it.

For analysis, pivot on `exercise` and `date`. Volume per set is `weight_kg × reps`.

## Behaviour worth knowing

- **Offline.** Gym wifi drops. A failed save is held on the device and goes up on the next save or when the connection returns. `batch_id` stops a retry from writing twice.
- **Drafts.** A part-finished session survives closing the tab, including an attached heart rate file. Keyed by person, session and date.
- **Wrong date on a heart rate file** shows a warning but still saves against today.

## Two things this does not do

**The secret is not security.** GitHub Pages serves your source publicly, so anyone who finds the URL can read `SECRET` and write to the sheet. It stops drive-by junk, nothing more. If that matters, the fix is Google OAuth on the Apps Script side, which costs a sign-in on every phone. For a private family training log the tradeoff is probably fine — decide it deliberately rather than assuming the secret protects anything.

**No editing past sessions.** Corrections happen in the sheet. An edit UI needs row lookup, update and delete paths in the script, which is not worth it for something that happens rarely.

## If it stops working

- **Saves fail after you change `Code.gs`.** Apps Script serves the deployed version, not the saved one. `Deploy ▸ Manage deployments ▸ edit ▸ Version: New version`.
- **Carried-over values are empty but saving works.** The `doGet` path is failing. Open the `/exec` URL with `?action=last&user=ikarus&secret=...` in a browser and read the error.
- **"No heart rate values in that file."** The export didn't include heart rate, or it's a FIT file. Re-export as CSV or TCX with heart rate enabled.
- **Nothing works after a Google account change.** Redeploy; the web app URL is tied to the account that deployed it.
