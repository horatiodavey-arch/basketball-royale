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

    document.querySelectorAll('details.cs-menu[open], details.cs-add[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
})();
