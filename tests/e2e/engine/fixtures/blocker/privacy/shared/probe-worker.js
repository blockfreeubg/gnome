// A dedicated worker's own request (row P12): it carries Sec-GPC, while the worker has no navigator.globalPrivacyControl.
onmessage = function (e) {
  fetch(e.data)
    .then(function (r) { return r.json(); })
    .then(function (j) { postMessage({ echo: j, gpc: self.navigator.globalPrivacyControl === undefined ? null : self.navigator.globalPrivacyControl }); })
    .catch(function (err) { postMessage({ error: String(err) }); });
};
