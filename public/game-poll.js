// Game now on the phone: the "Did you win?" question every 10 minutes during a
// game, the "You're up" prompt when the court is free and you're first in line,
// and the Send QR link buttons.
(function () {
  var open = false;
  var CHECK_MS = 30000;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function sheet(title, text) {
    var s = el('div', 'gp-sheet');
    s.setAttribute('role', 'dialog');
    s.appendChild(el('div', 'gp-title', title));
    if (text) s.appendChild(el('p', 'gp-text', text));
    document.body.appendChild(s);
    return s;
  }

  function answer(liveGameId, round, value, s) {
    var buttons = s.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    fetch('/live_games/' + liveGameId + '/poll', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ round: round, answer: value }),
    })
      .then(function () { s.remove(); open = false; check(); })
      .catch(function () { s.remove(); open = false; });
  }

  function showPoll(poll) {
    if (open) return;
    open = true;
    var s = sheet('Did you win?', 'Quick check, every 10 minutes. Your answer settles it when the other side answers the opposite.');
    var row = el('div', 'gp-row');
    [['Yes', 'yes', 'gp-yes'], ['No', 'no', 'gp-no'], ['Still playing', 'still', 'gp-still']].forEach(function (b) {
      var btn = el('button', 'gp-btn ' + b[2], b[0]);
      btn.type = 'button';
      btn.addEventListener('click', function () { answer(poll.liveGameId, poll.round, b[1], s); });
      row.appendChild(btn);
    });
    s.appendChild(row);
  }

  var shownUp = {};
  function showUp(up) {
    var key = 'royale_up_' + up.nextLineId;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) { /* show anyway */ }
    if (shownUp[up.nextLineId]) return;
    shownUp[up.nextLineId] = true;
    var s = sheet("You're up", 'The court is free and your team is next. Head to the court.');
    var btn = el('button', 'gp-btn gp-yes', 'Got it');
    btn.type = 'button';
    btn.addEventListener('click', function () { s.remove(); });
    s.appendChild(btn);
  }

  function check() {
    if (document.hidden) return;
    fetch('/api/game-status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.poll) showPoll(d.poll);
        if (d.up) showUp(d.up);
      })
      .catch(function () {});
  }

  // Send QR link: share the link, or copy it where sharing isn't offered.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-share-url]');
    if (!btn) return;
    var url = btn.getAttribute('data-share-url');
    if (navigator.share) {
      navigator.share({ title: 'Basketball Royale', text: 'Join the game on Royale', url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () { btn.textContent = 'Link copied'; }).catch(function () {});
    }
  });

  if (!document.querySelector('.nav-bar')) return;
  check();
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', check);
})();
