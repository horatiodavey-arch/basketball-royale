// The one place this app reads the phone's location, so every page asks
// for it the same way: GPS-grade accuracy, a 10-second limit, and never a
// reading more than 15 seconds old. Distances are straight-line (as the
// crow flies), and labelled that way so nobody reads them as a drive.
window.RoyaleGeo = (function () {
  var OPTIONS = { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 };
  // A fix the phone itself says could be off by more than this isn't
  // trusted to decide a check-in until one retry has had its chance.
  var POOR_ACCURACY_METERS = 100;

  function getPosition(onSuccess, onError, overrides) {
    var fail = onError || function () {};
    if (!navigator.geolocation) { fail(null); return; }
    var options = {
      enableHighAccuracy: OPTIONS.enableHighAccuracy,
      timeout: OPTIONS.timeout,
      maximumAge: OPTIONS.maximumAge,
    };
    for (var key in overrides || {}) options[key] = overrides[key];
    navigator.geolocation.getCurrentPosition(onSuccess, fail, options);
  }

  // True when the phone's own error estimate is too wide to say for sure
  // which side of a park's check-in radius the player is on.
  function isRoughFix(pos) {
    return pos.coords.accuracy > POOR_ACCURACY_METERS;
  }

  // For check-in. If the first fix is rough, say so and take one more —
  // a brand new reading this time (maximumAge 0), since a cached one would
  // just be the same rough fix again — then go with the better of the two.
  function getCheckInPosition(onStatus, onSuccess, onError) {
    getPosition(function (first) {
      if (!isRoughFix(first)) { onSuccess(first); return; }
      onStatus('Getting a better GPS signal…');
      getPosition(function (second) {
        onSuccess(second.coords.accuracy <= first.coords.accuracy ? second : first);
      }, function () {
        onSuccess(first);
      }, { maximumAge: 0 });
    }, onError);
  }

  // The whole "Check in" tap, shared by the map, the park page, and Runs:
  // find the player (retrying once on a rough fix), then ask the server.
  //   opts.url       where to POST
  //   opts.body      optional (position) -> request body, for check-ins
  //                  that send more than the player's own position
  //   opts.onStatus  (text) progress line to show
  //   opts.onDone    (response) checked in
  //   opts.onFail    (text) why not
  function checkIn(opts) {
    if (!navigator.geolocation) { opts.onFail('Location not available on this device.'); return; }
    opts.onStatus('Finding you…');
    getCheckInPosition(opts.onStatus, function (pos) {
      var body = opts.body ? opts.body(pos) : {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      fetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) opts.onDone(data);
          else opts.onFail(data.error || 'Could not check in.');
        })
        .catch(function () { opts.onFail('Could not check in.'); });
    }, function (err) {
      opts.onFail(err && err.code === 1
        ? 'Location permission denied.'
        : "Couldn't get your location. Try again.");
    });
  }

  // While checked in: report position once a minute so the server knows
  // the player is still at the park. A cycle with no fix is just skipped
  // — the "still here" clock isn't extended until the next good one.
  function startHeartbeat(parkId) {
    setInterval(function () {
      getPosition(function (pos) {
        fetch('/parks/' + parkId + '/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        }).catch(function () {});
      });
    }, 60000);
  }

  function haversineMiles(lat1, lng1, lat2, lng2) {
    var R = 3958.8;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // "2.0 mi away (straight line)" — wherever there's room to say it.
  function distanceLabel(miles) {
    return miles.toFixed(1) + ' mi away (straight line)';
  }

  // "~2 mi" — for a map pin, where there isn't.
  function pinDistanceLabel(miles) {
    return '~' + (miles >= 1 ? Math.round(miles) : miles.toFixed(1)) + ' mi';
  }

  return {
    OPTIONS: OPTIONS,
    getPosition: getPosition,
    isRoughFix: isRoughFix,
    checkIn: checkIn,
    startHeartbeat: startHeartbeat,
    haversineMiles: haversineMiles,
    distanceLabel: distanceLabel,
    pinDistanceLabel: pinDistanceLabel,
  };
})();
