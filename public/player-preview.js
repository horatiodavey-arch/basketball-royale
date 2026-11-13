// Tap (or hover, on a computer) an avatar to see a short preview of that player.
// Tapping elsewhere closes it. The preview's "View profile" link still works.
(function () {
  document.addEventListener('click', function (e) {
    if (e.target.closest('.person-preview')) return;
    var chip = e.target.closest('.person-chip');
    document.querySelectorAll('.person-chip.open').forEach(function (c) {
      if (c !== chip) c.classList.remove('open');
    });
    if (chip) {
      e.preventDefault();
      chip.classList.toggle('open');
    }
  });
})();
