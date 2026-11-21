// Auto check-in, for signed-in players while the app is open.
//
// Every 30 seconds the phone reads its location and works out, on the phone,
// which court it's at: the closest one whose check-in radius it's inside (one
// court at a time, even where radii overlap). The location isn't sent
// anywhere for this until it's time to check in.
//
// - Inside the same court's radius for 2 straight minutes: check in, and show
//   "You're checked in at [Court] · Undo". Undo checks out, and there's no
//   auto check-in at that court for 30 minutes.
// - Once checked in, each reading goes to the server as the "still here"
//   heartbeat. Only a good reading outside the radius counts as leaving; the
//   server checks the player out after 5 minutes of that (never while they're
//   on a roster in a live game). A closed app or locked phone sends nothing,
//   so it never counts as leaving.
// - The manual "Check in" button stays as the backup.
(function () {
  if (!window.RoyaleGeo || !navigator.geolocation || !window.fetch) return;

  var EVERY_MS = 30000;
  var HOLD_MS = 2 * 60 * 1000;
  var ROUGH_METERS = 100;
  var KEY = 'royale_auto_check_in';
  var TOAST_KEY = 'royale_auto_check_in_toast';

  var parks = null;
  var checkedInParkId = null;
  var snoozed = {};
  var busy = false;

  function load() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function save(v) {
    try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch (e) {}
  }

  function metersBetween(lat1, lng1, lat2, lng2) {
    return RoyaleGeo.haversineMiles(lat1, lng1, lat2, lng2) * 1609.344;
  }

  // The closest court whose check-in radius this position is inside.
  function courtHere(lat, lng) {
    var best = null;
    for (var i = 0; i < parks.length; i++) {
      var p = parks[i];
      var d = metersBetween(lat, lng, p.lat, p.lng);
      if (d <= p.r && (!best || d < best.d)) best = { park: p, d: d };
    }
    return best ? best.park : null;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function toast(parkId, name) {
    var old = document.getElementById('autoCheckInToast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'autoCheckInToast';
    el.className = 'auto-check-in-toast';
    el.setAttribute('role', 'status');
    var text = document.createElement('span');
    text.className = 'auto-check-in-text';
    text.textContent = "You're checked in at " + name;
    var dot = document.createElement('span');
    dot.textContent = '·';
    var undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Undo';
    undo.addEventListener('click', function () {
      undo.disabled = true;
      post('/parks/' + parkId + '/auto-check-in/undo').then(function () {
        snoozed[parkId] = true;
        checkedInParkId = null;
        save(null);
        el.remove();
        location.reload();
      }).catch(function () { undo.disabled = false; });
    });
    el.appendChild(text);
    el.appendChild(dot);
    el.appendChild(undo);
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 10000);
  }

  function tick() {
    if (busy || document.hidden) return;
    busy = true;
    RoyaleGeo.getPosition(function (pos) {
      busy = false;
      var c = pos.coords;
      var body = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };

      // Checked in: this reading is the heartbeat for that park.
      if (checkedInParkId) {
        post('/parks/' + checkedInParkId + '/heartbeat', body).then(function (r) {
          if (r && r.checkedIn === false) checkedInParkId = null;
        }).catch(function () {});
      }

      // A rough fix can't place the player at a court.
      if (c.accuracy > ROUGH_METERS) return;
      var here = courtHere(c.latitude, c.longitude);
      if (!here || here.id === checkedInParkId || snoozed[here.id]) { save(null); return; }

      var state = load();
      var now = Date.now();
      if (!state || state.parkId !== here.id) { save({ parkId: here.id, since: now }); return; }
      if (now - state.since < HOLD_MS) return;

      // 2 straight minutes inside: check in.
      busy = true;
      post('/parks/' + here.id + '/auto-check-in', body).then(function (r) {
        busy = false;
        save(null);
        if (r && r.snoozed) { snoozed[here.id] = true; return; }
        if (r && r.ok && !r.already) {
          // Refresh so the page shows the player as here (an "I'm coming"
          // turns from yellow to green), then show the toast.
          try { sessionStorage.setItem(TOAST_KEY, JSON.stringify({ parkId: here.id, name: r.parkName || here.name })); } catch (e) {}
          location.reload();
        } else if (r && r.ok) {
          checkedInParkId = here.id;
        }
      }).catch(function () { busy = false; });
    }, function () { busy = false; });
  }

  // The toast from an auto check-in that just refreshed the page.
  try {
    var pending = JSON.parse(sessionStorage.getItem(TOAST_KEY) || 'null');
    sessionStorage.removeItem(TOAST_KEY);
    if (pending) {
      if (document.body) toast(pending.parkId, pending.name);
      else document.addEventListener('DOMContentLoaded', function () { toast(pending.parkId, pending.name); });
    }
  } catch (e) {}

  fetch('/api/auto-check-in/parks', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      parks = data.parks || [];
      checkedInParkId = data.checkedInParkId || null;
      (data.snoozed || []).forEach(function (id) { snoozed[id] = true; });
      tick();
      setInterval(tick, EVERY_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    })
    .catch(function () {});

  window.RoyaleAutoCheckIn = { tick: tick };
})();
