// The result pop-up. After a game's result locks, every player on it sees one
// bottom sheet: the newest unseen result, with a link to the rest. It shows
// right away if the app is open (checked every 20 seconds while visible), or
// the next time they open the app. Closing it marks everything seen.
(function () {
  var open = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var CROWN = function (fill, stroke, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24">' +
      '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5L3 8z" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="M5 20.5h14" stroke="' + stroke + '" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
  };
  var BALL = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#8A8F98" stroke-width="1.6" stroke-linecap="round">' +
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c3.5 3.5 3.5 9.3 0 12.8M18.4 5.6c-3.5 3.5-3.5 9.3 0 12.8"/></svg>';

  function sheetHtml(d) {
    var more = d.count > 1 ? '<a class="rp-more" href="/runs" data-rp-close>+' + (d.count - 1) + ' more result' + (d.count - 1 === 1 ? '' : 's') + '</a>' : '';
    var head = '<div class="rp-handle"></div>' + more;

    if (d.kind === 'voided') {
      return head +
        '<div class="rp-voided"><div class="rp-voided-title">Game ' + esc(d.liveGameId) + ' was voided.</div>' +
        '<div class="rp-voided-body">No points were added.</div>' +
        '<button type="button" class="rp-btn rp-btn-solid" data-rp-close>OK</button></div>';
    }

    var won = d.outcome === 'win';
    var icon = '<div class="rp-icon ' + (won ? 'rp-icon-win' : 'rp-icon-loss') + '">' +
      (won ? CROWN('#D9A520', '#8A6408', 34) : BALL) + '</div>';
    var title = '<div class="rp-title">' + (won ? 'You won!' : 'Good run.') + '</div>';
    var beat = won
      ? 'Your team beat Team ' + esc(d.oppTeam) + '.'
      : 'Team ' + esc(d.oppTeam) + ' beat your team.';
    var meta = '<div class="rp-meta">Game ' + esc(d.liveGameId) + ' · ' + esc(d.format || 'Legacy game') + ' · ' + esc(d.parkName) + '</div>';
    var confirmed = '<div class="rp-confirmed">✓ Confirmed by both teams</div>';

    var lines = '';
    if (d.newCrown && d.crownAfter) {
      lines += '<div class="rp-newcrown">' + CROWN(d.crownAfter.fill, d.crownAfter.stroke, 18) +
        '<span>New crown: ' + esc(d.crownAfter.name) + '</span></div>';
    }
    if (d.trophyEarned) {
      lines += '<div class="rp-trophy">Trophy earned! ' + esc(d.format) + ' trophies: ' + esc(d.trophyCount) + '</div>';
    }

    var points = '';
    if (!d.legacy) {
      var rows = '';
      if (won) rows += '<div class="rp-row"><span>Win</span><span>+' + esc(d.winPoints) + '</span></div>';
      rows += '<div class="rp-row"><span>Game played</span><span>+1</span></div>';
      if (d.hours > 0) rows += '<div class="rp-row"><span>Court time</span><span>+' + esc(d.hours) + '</span></div>';
      var total = Number(d.gained);
      points = '<div class="rp-points">' + rows +
        '<div class="rp-divider"></div>' +
        '<div class="rp-row rp-total"><span>This game</span><span class="rp-total-num">+' + esc(total) + ' pt' + (total === 1 ? '' : 's') + '</span></div>' +
        '</div>';
    }

    var progress = '';
    if (!d.legacy && d.pointsAfter !== null) {
      var current = d.crownAfter ? d.crownAfter.name : 'No crown yet';
      var right = d.nextCrown ? esc(Math.round((d.nextCrown.min - d.pointsAfter) * 10) / 10) + ' pts to ' + esc(d.nextCrown.name) : 'Best crown reached';
      var pct = Math.round((d.progress || 0) * 100);
      progress = '<div class="rp-progress">' +
        '<div class="rp-progress-labels"><span>' + esc(current) + ' · ' + esc(d.pointsAfter) + ' pts</span><span>' + right + '</span></div>' +
        '<div class="rp-track"><div class="rp-fill" style="width:' + pct + '%"></div></div></div>';
    }

    var park = '';
    if (won) {
      park = d.isKing
        ? '<div class="rp-park">You’re the King of this park.</div>'
        : (d.parkGap !== null ? '<div class="rp-park">You’re ' + esc(d.parkGap) + ' pts behind the crown at this park.</div>' : '');
    }

    var actions;
    if (won) {
      actions = '<a class="rp-btn rp-btn-solid" href="/runs" data-rp-close>Back to the run</a>' +
        '<a class="rp-link" href="/players/' + esc(d.playerId) + '" data-rp-close>View my profile</a>';
    } else {
      park = '<div class="rp-park">Run it back: get in line and earn your +3 next game.</div>';
      actions = '<form method="POST" action="/courts/' + esc(d.courtId) + '/next" class="rp-form" data-rp-submit>' +
        '<button type="submit" class="rp-btn rp-btn-solid">I got next</button></form>' +
        '<a class="rp-btn rp-btn-outline" href="/runs" data-rp-close>Back to the run</a>';
    }

    return head + icon + title + '<div class="rp-beat">' + beat + '</div>' + meta + (won || !d.legacy ? confirmed : '') +
      lines + points + progress + park + '<div class="rp-actions">' + actions + '</div>';
  }

  function markSeen() {
    fetch('/api/result-popups/seen', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(function () {});
  }

  function close(overlay) {
    markSeen();
    overlay.remove();
    open = false;
  }

  function show(d) {
    open = true;
    var overlay = document.createElement('div');
    overlay.className = 'rp-overlay';
    overlay.innerHTML = '<div class="rp-sheet" role="dialog" aria-label="Result">' + sheetHtml(d) + '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('rp-in'); });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.closest('[data-rp-close]')) close(overlay);
    });
    overlay.querySelectorAll('[data-rp-submit]').forEach(function (form) {
      form.addEventListener('submit', markSeen);
    });
  }

  function check() {
    if (open || document.hidden) return;
    fetch('/api/result-popups', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.count > 0 && !open) show(d); })
      .catch(function () {});
  }

  // Today's run reopens a past result's pop-up through this.
  window.RoyaleResultPopup = { show: show };

  check();
  setInterval(check, 20000);
  document.addEventListener('visibilitychange', check);
})();
