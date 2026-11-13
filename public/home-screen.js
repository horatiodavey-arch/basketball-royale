// Home-screen install: registers the offline shell cache, logs when the app is
// opened from the home screen, and shows a small card that invites a player to
// add Royale to their home screen. "Not now" hides the card for 3 days. The
// card is never shown inside the installed app.
(function () {
  var DISMISS_MS = 3 * 24 * 60 * 60 * 1000;
  var DISMISSED_KEY = 'royale_a2hs_dismissed_at';
  var HOME_DAY_KEY = 'royale_home_logged_day';
  var SHOWN_KEY = 'royale_a2hs_shown';

  function read(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }
  function write(storage, key, value) {
    try { storage.setItem(key, value); } catch (e) { /* private mode: the card just shows again */ }
  }
  function track(name) {
    try {
      fetch('/api/events', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name }),
      }).catch(function () {});
    } catch (e) { /* tracking is best effort */ }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  var installed = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  if (installed) {
    var today = new Date().toISOString().slice(0, 10);
    if (read(localStorage, HOME_DAY_KEY) !== today) {
      write(localStorage, HOME_DAY_KEY, today);
      track('opened_from_home_screen');
    }
    return;
  }

  // The card only appears on the app's pages (the ones with the bottom nav).
  if (!document.querySelector('.nav-bar')) return;

  var dismissedAt = Number(read(localStorage, DISMISSED_KEY) || 0);
  if (dismissedAt && Date.now() - dismissedAt < DISMISS_MS) return;
  if (read(sessionStorage, SHOWN_KEY)) return;

  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var deferredPrompt = null;
  var card = null;

  function hide() {
    if (card) card.remove();
    card = null;
  }

  function dismiss() {
    write(localStorage, DISMISSED_KEY, String(Date.now()));
    track('install_prompt_dismissed');
    hide();
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function shareIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 11H6v10h12V11h-2"/>';
    svg.classList.add('a2hs-share-icon');
    return svg;
  }

  function addButton() {
    var btn = el('button', 'a2hs-primary', 'Add to home screen');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        deferredPrompt = null;
        if (choice.outcome === 'dismissed') {
          dismiss();
        } else {
          hide();
        }
      });
    });
    return btn;
  }

  function buildBody(mode) {
    var wrap = el('div', 'a2hs-body');
    if (mode === 'ios') {
      var steps = el('ol', 'a2hs-steps');
      var one = el('li', null, 'Tap the Share button ');
      one.appendChild(shareIcon());
      one.appendChild(document.createTextNode(' at the bottom of Safari.'));
      steps.appendChild(one);
      steps.appendChild(el('li', null, 'Tap "Add to Home Screen."'));
      wrap.appendChild(steps);
    } else if (mode === 'button') {
      wrap.appendChild(addButton());
    } else {
      wrap.appendChild(el('p', 'a2hs-hint', 'Use your browser menu and choose "Add to Home screen."'));
    }
    return wrap;
  }

  function show(mode) {
    if (card) hide();
    card = el('div', 'a2hs-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Add Royale to your home screen');
    card.appendChild(el('div', 'a2hs-title', 'Add BR to your home screen'));
    card.appendChild(el('p', 'a2hs-text', "So it's one tap away at the court."));
    card.appendChild(buildBody(mode));
    var notNow = el('button', 'a2hs-later', 'Not now');
    notNow.type = 'button';
    notNow.addEventListener('click', dismiss);
    card.appendChild(notNow);
    document.body.appendChild(card);
    if (!read(sessionStorage, SHOWN_KEY)) {
      write(sessionStorage, SHOWN_KEY, '1');
      track('install_prompt_shown');
    }
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (card && !isIos) show('button');
  });
  window.addEventListener('appinstalled', hide);

  // Wait a moment for the browser to say whether it can install this app.
  setTimeout(function () {
    if (isIos) show('ios');
    else show(deferredPrompt ? 'button' : 'menu');
  }, 1500);
})();
