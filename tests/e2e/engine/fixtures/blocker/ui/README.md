# Fixtures of lane x4 (app UI, `suites/shell-blocker.mjs`, WAVE-B3 §12.2 rows U1–U13)

Served by `servers/blocker-fixtures.mjs` as `http://<label>.localhost:<port>/ui/<path>` (host-specific files in
`<label>/`, the rest in `shared/`). Test data written for GNOME's e2e tests (CC0-1.0).

- `site-a/u3.html`: a page that loads three images from `ads.localhost` (beacons) and links to `docblock.localhost`.
- `docblock/index.html`: the page a blocked navigation leads to (rows U6).
- `shared/index.html`: a plain page per host (title = the host).
- `site-a/u3.html` also loads one image from `trk.localhost` and links to `bad.localhost` (the scam and malware test list).
- `site-a/u2.html`: row U2 — a box the e2e cosmetic list hides on site-a (`.gnome-cs1-ad`, lane x2's site rule), its own
  `Sec-GPC` header read from `/echo`, and with `?c=<name>` a site-b frame that sets the cookie `<name>` (third-party).
- `site-a/u3s.html`: u3.html's four images made by script after load (no parser preload), for U3's cross-check.
