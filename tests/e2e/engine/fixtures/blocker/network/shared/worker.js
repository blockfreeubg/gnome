// A dedicated worker of the page (rows V8): its fetch to the ad host must be judged as third-party.
fetch('{{origin:ads}}/network/ad.js').then((r) => postMessage('status:' + r.status), (e) => postMessage('error:' + e.name));
self.onconnect = (e) => e.ports[0].postMessage('shared worker ran');
