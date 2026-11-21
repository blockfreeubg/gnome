# Lane x1 network fixtures (docs/WAVE-B3.md §12.2 rows N1–N19, V-, S- and A-rows)

`shared/page.html?p=<probe,probe…>` loads the probes it names and writes what happened into `#out` (JSON) after its
`load`: scripts (`ad`, `ok`, `bf`, `stub`, `rr`, `trkjs`), images (`trk`, `bad`), frames (`adframe`, `frame2`,
`inner-b`), `fetch` + XHR (`fetch`; `big`: a host only the generated big list names), credentialed fetches whose
`Cookie` and `Sec-GPC` the suites read from the fixture server's log (`echob`: site-b, third-party; `echoself`: the
page's own host), WebSockets (`ws`, `wsok`), a direct connection GNOME's CSP stops (`direct`), and a link `#link` to
`?to=`.

The other pages:

- `counts.html` (three ads.localhost images and one trk.localhost image in the markup, which the parser may request
  before the engines' document start) and `counts-script.html` (the same four made by script after load): row N13b,
  the counts the app shows.
- `unbreak.html`: a page that locks its own scrolling; row N19 (a root/body `:style()` rule that only restores the page
  applies, one that would hide the root is dropped).
- `v2.html?d=<n>&top=1`: a chain of nested frames, each loading a first-party script; row V2 (requests judged without
  their page context).
- `uvctx.html` (rows V5–V9), `a0.html`, `a1.html`, `attack.html`, `a7.html`, `cors.html` (the A-rows), `inner.html`,
  `adframe.html`, `frame2.html`, `worker.js` and the scripts they load.

The test lists are `lists/network.txt` (ads), `lists/network-trackers.txt` (privacy), `lists/network-security.txt`
(security) and `lists/network-s5.txt` (row S5 only). Test data written for GNOME's e2e tests (CC0-1.0).
