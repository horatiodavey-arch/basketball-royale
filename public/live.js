// Keeps a leaderboard or profile current without a page reload. Every 15
// seconds, while the page is open and visible, it asks the server whether
// anything changed; only changed parts are swapped in. Rows whose rank moved
// are briefly highlighted.
(function () {
  var INTERVAL_MS = 15000;
  var HIGHLIGHT_MS = 2600;

  var source = document.querySelector('[data-live-url]');
  if (!source) return;
  var url = source.getAttribute('data-live-url');
  var version = source.getAttribute('data-live-v');
  var busy = false;

  function ranksNow() {
    var ranks = {};
    document.querySelectorAll('[data-player][data-rank]').forEach(function (el) {
      ranks[el.getAttribute('data-player')] = el.getAttribute('data-rank');
    });
    return ranks;
  }

  function highlightMoves(before) {
    document.querySelectorAll('[data-player][data-rank]').forEach(function (el) {
      if (before[el.getAttribute('data-player')] === el.getAttribute('data-rank')) return;
      el.classList.remove('live-moved');
      void el.offsetWidth;
      el.classList.add('live-moved');
      setTimeout(function () { el.classList.remove('live-moved'); }, HIGHLIGHT_MS);
    });
  }

  function poll() {
    if (document.hidden || busy) return;
    busy = true;
    fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(version), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        busy = false;
        if (!data) return;
        version = data.v;
        if (!data.changed) return;
        var before = ranksNow();
        document.querySelectorAll('[data-live-key]').forEach(function (el) {
          var html = data[el.getAttribute('data-live-key')];
          if (typeof html === 'string') el.innerHTML = html;
        });
        highlightMoves(before);
      })
      .catch(function () { busy = false; });
  }

  setInterval(poll, INTERVAL_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });
})();
