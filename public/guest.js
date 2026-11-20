// Guests can look around. Check in needs an account: the tap goes to phone
// sign-up first, then back to this page, which checks in for them.
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('#homeCheckInBtn, #checkInBtn, #runCheckInBtn, .suggested-checkin-btn');
    if (!btn) return;
    var parkId = btn.getAttribute('data-park-id');
    if (!parkId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var back = location.pathname + location.search.replace(/[?&]autocheckin=\d+/, '');
    location.href = '/signup?checkin=' + encodeURIComponent(parkId) + '&returnTo=' + encodeURIComponent(back);
  }, true);
})();
