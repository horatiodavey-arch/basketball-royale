// Court sheet: the Share icon (the phone's share sheet, else copy the link),
// "You're #X in line" → tap → "Leave line" → tap again to leave, and closing
// the ··· menu / + Add player panel when tapping elsewhere.
(function () {
  document.addEventListener('click', function (e) {
    var share = e.target.closest && e.target.closest('[data-cs-share]');
    if (share) {
      var url = window.location.origin + share.getAttribute('data-url');
      var text = share.getAttribute('data-text') || '';
      if (window.RoyaleTrack) window.RoyaleTrack.report('invite_friends');
      if (navigator.share) {
        navigator.share({ title: 'Basketball Royale', text: text, url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(text + ' ' + url).then(function () {
          share.setAttribute('title', 'Link copied');
        });
      } else {
        window.prompt('Copy this link', url);
      }
      return;
    }

    var leave = e.target.closest && e.target.closest('[data-cs-leave]');
    if (leave) {
      if (leave.getAttribute('data-armed') === '1') {
        leave.closest('form').submit();
        return;
      }
      leave.setAttribute('data-armed', '1');
      leave.textContent = 'Leave line';
      leave.classList.add('is-leave');
      setTimeout(function () {
        if (!leave.isConnected) return;
        leave.removeAttribute('data-armed');
        leave.textContent = leave.getAttribute('data-label');
        leave.classList.remove('is-leave');
      }, 5000);
      return;
    }

    // "At the court? Check in": show Check in and start it.
    var here = e.target.closest && e.target.closest('[data-cs-here]');
    if (here) {
      showNear();
      var btn = document.querySelector('[data-cs-near] button');
      if (btn) btn.click();
      return;
    }

    document.querySelectorAll('details.cs-menu[open], details.cs-add[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  // I'm coming first; Check in once the phone is inside the court's radius.
  function showNear() {
    document.querySelectorAll('[data-cs-near]').forEach(function (el) { el.style.display = ''; });
    document.querySelectorAll('[data-cs-far]').forEach(function (el) { el.style.display = 'none'; });
    var msg = document.querySelector('[data-cs-msg][data-near]');
    if (msg) msg.textContent = msg.getAttribute('data-near');
  }
  var main = document.querySelector('.cs-main[data-lat]');
  if (main && document.querySelector('[data-cs-near]') && window.RoyaleGeo && navigator.geolocation) {
    RoyaleGeo.getPosition(function (pos) {
      if (RoyaleGeo.isRoughFix(pos)) return;
      var meters = RoyaleGeo.haversineMiles(pos.coords.latitude, pos.coords.longitude,
        Number(main.getAttribute('data-lat')), Number(main.getAttribute('data-lng'))) * 1609.34;
      if (meters <= Number(main.getAttribute('data-radius'))) showNear();
      else document.querySelectorAll('[data-cs-here]').forEach(function (el) { el.style.display = 'none'; });
    });
  }
})();
