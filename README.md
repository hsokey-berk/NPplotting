# Neutron&ndash;Gamma Probe Viewer

A static site that reads your probe log directly from a Google Sheet and plots
Neutron Count vs Cable Length, with the same filtering options as the
`NPPlot.m` function: site, hole ID, year, month, cable unit, and month/year
comparisons.

No backend, no build step &mdash; it's plain HTML/CSS/JS, so it runs for free
on GitHub Pages.

## 1. Publish your Google Sheet as CSV

This is different from the normal "Share" button &mdash; you need the
**Publish to web** link, which is a public read-only CSV endpoint that
doesn't require anyone to sign in to Google.

1. Open your Google Sheet.
2. **File > Share > Publish to web**.
3. Under the first dropdown, pick the specific tab your data is on (not
   "Entire Document," unless there's only one tab).
4. Under the second dropdown, choose **Comma-separated values (.csv)**.
5. Click **Publish**, confirm, then copy the URL shown.
6. Open `config.js` in this folder and paste that URL as the value of
   `CSV_URL`.

Any time you edit and save the sheet, the published CSV updates within a
minute or two automatically &mdash; no republishing needed.

**Column names must match exactly** (case and spelling): `Site`, `Hole ID`,
`Date`, `Cable length (ft)`, `Neutron Count (MD)`. The other columns
(Probe Model, Serial Number, etc.) can stay in the sheet; the site just
ignores them.

**Date format**: dates are read as month/day/year (matching your CSV, e.g.
`8/5/2026`). If your sheet ever switches to day/month/year, edit the
`parseDateMDY` function in `script.js`.

## 2. Put this on GitHub Pages

1. Create a new repository on GitHub (e.g. `neutron-probe-viewer`) &mdash;
   public, no need to initialize with a README since you already have one.
2. Upload these four files to the repo root: `index.html`, `style.css`,
   `script.js`, `config.js` (with your CSV_URL already pasted in).
   Easiest way: on the repo page, **Add file > Upload files**, drag all
   four in, and commit.
3. Go to the repo's **Settings > Pages**.
4. Under **Source**, choose **Deploy from a branch**, branch `main`,
   folder `/ (root)`, then **Save**.
5. GitHub will give you a URL like
   `https://yourusername.github.io/neutron-probe-viewer/` within a minute
   or two &mdash; that's your live site.

From then on, editing the Google Sheet updates the data automatically;
editing the site files means re-uploading (or `git push` if you clone the
repo locally instead of using the web uploader).

## 3. Using it

- Pick **Site**, then **Hole ID** &mdash; the hole list updates to only
  show holes that exist for the chosen site.
- Pick **Year** and **Month** for cable length/neutron count.
- **Cable length units**: feet or meters.
- **Compare against**:
  - *Nothing* &mdash; plots just the selected month.
  - *A different month* &mdash; pick a second year/month to overlay
    (e.g. June 2026 vs August 2026).
  - *Same month, other years* &mdash; check which years to overlay
    (e.g. August across 2024, 2025, 2026); years with no data for that
    hole are simply skipped, which is noted under the Plot button.

## Notes / known limits

- The published-CSV approach means the sheet is effectively public to
  anyone with the link. That matches how you said it's currently shared,
  but worth keeping in mind if the data becomes sensitive later &mdash; at
  that point you'd need a proper backend with authentication instead.
- Rows with a missing Site, Date, Cable length, or Neutron Count are
  silently skipped rather than breaking the plot. Rows with an
  unparseable date are also skipped.
- If nothing loads, check the browser console (F12) &mdash; the most
  common causes are a wrong `CSV_URL`, a sheet that isn't actually
  published, or a column header that doesn't match exactly.
