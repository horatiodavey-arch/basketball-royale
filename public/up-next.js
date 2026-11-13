// Profile toggle for "You're up next" alerts. Turning it on asks the browser for
// permission and saves the push subscription; turning it off removes it.
(function () {
  var wrap = document.getElementById('upNextWrap');
  var btn = document.getElementById('upNextBtn');
  var note = document.getElementById('upNextNote');
  if (!wrap || !btn) return;

  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function show() { wrap.hidden = false; }
  function say(text) { note.textContent = text; }

  if (ios && !standalone) {
    // On iPhone, push only works once Royale is on the home screen.
    show();
    btn.hidden = true;
    say('On iPhone, add Royale to your home screen first, then turn this on.');
    return;
  }
  if (!supported) return;

  fetch('/api/push/key', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.key) return;
      var key = data.key;
      show();
      navigator.serviceWorker.ready
        .then(function (reg) { return reg.pushManager.getSubscription().then(function (sub) { return { reg: reg, sub: sub }; }); })
        .then(function (st) {
          render(st.sub);
          btn.onclick = function () { toggle(st.reg, st.sub, key); };
        })
        .catch(function () {});
    })
    .catch(function () {});

  function render(sub) {
    btn.textContent = sub ? 'Turn off up-next alerts' : "Notify me when I'm up next";
    say(sub ? "You'll get a message when you're first in line." : '');
  }

  function toggle(reg, sub, key) {
    btn.disabled = true;
    if (sub) {
      var endpoint = sub.endpoint;
      sub.unsubscribe()
        .then(function () {
          return fetch('/api/push/unsubscribe', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: endpoint }),
          });
        })
        .then(function () { render(null); })
        .catch(function () { say('Could not turn this off. Try again.'); })
        .then(function () { btn.disabled = false; });
      return;
    }
    Notification.requestPermission()
      .then(function (permission) {
        if (permission !== 'granted') {
          say('Notifications are blocked. Allow them in your browser settings, then try again.');
          return null;
        }
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(key) });
      })
      .then(function (newSub) {
        if (!newSub) return;
        return fetch('/api/push/subscribe', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(newSub.toJSON()),
        }).then(function () { render(newSub); });
      })
      .catch(function () { say('Could not turn this on. Try again.'); })
      .then(function () { btn.disabled = false; });
  }

  function base64ToBytes(s) {
    var pad = '='.repeat((4 - (s.length % 4)) % 4);
    var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
})();
