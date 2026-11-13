// Today's run: tapping a result reopens that game's result pop-up.
// Delegated on document so it keeps working after a live refresh swaps the body.
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.tr-result[data-game]');
    if (!btn) return;
    e.preventDefault();
    var game = btn.getAttribute('data-game');
    fetch('/api/result-popups/game/' + encodeURIComponent(game), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.ok && window.RoyaleResultPopup) window.RoyaleResultPopup.show(d);
      })
      .catch(function () {});
  });
})();
