# Cosmetic-filtering fixtures (lane x2, docs/WAVE-B3.md §12.2 rows CS1–CS18, A2)

Served by `servers/blocker-fixtures.mjs` at `http://<label>.localhost:<port>/cosmetic/<path>` from `<label>/<path>`
(`{{port}}`, `{{origin:<label>}}` are filled in). The rules are in `../lists/cosmetic.txt` (untrusted) and
`../lists/cosmetic-trusted.txt` (trusted); the suite is `suites/blocker-cosmetic.mjs`. Each page writes what its own
scripts saw into `<pre id="out">` (JSON); the suite reads computed styles itself.

Lane additions that are not plan rows: `site-a/cs4.html#cs-href` (a hiding rule that selects a link by its address:
both engines rewrite the attribute, a measured limitation), `cdn/cs5.html` (selectors that open a block of their own),
and `site-b/cs-late.html` (row cs-late: a page opened while the build is held gets its styles and generic rules late,
not its scriptlets, and records the realm of everything GNOME's late steps hand it).
