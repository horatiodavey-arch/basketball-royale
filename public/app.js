// Basketball Royale front end: one small hash-routed app, no build step.
// Home screen follows br_rookie_home_mockup.html; everything is driven by the API.

const screen = document.getElementById('screen');
const toastEl = document.getElementById('toast');
const store = {
  get token() { try { return localStorage.getItem('br_token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('br_token', v) : localStorage.removeItem('br_token'); } catch {} },
  get pendingJoin() { try { return sessionStorage.getItem('br_join'); } catch { return null; } },
  set pendingJoin(v) { try { v ? sessionStorage.setItem('br_join', v) : sessionStorage.removeItem('br_join'); } catch {} },
};

// ---- helpers ----------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const money = (cents) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${abs % 100 === 0 ? abs / 100 : (abs / 100).toFixed(2)}`;
};
const stakeRange = (t) => t.max_stake_cents == null ? `${money(t.min_stake_cents)}+`
  : t.min_stake_cents === t.max_stake_cents ? money(t.min_stake_cents)
  : `${money(t.min_stake_cents)}–${money(t.max_stake_cents).slice(1)}`;
// What a winner takes home in a 5-on-5 at this stake and rake.
const winPays = (stake, rake) => {
  const pot = stake * 10;
  return Math.floor((pot - Math.floor(pot * rake / 100)) / 5);
};
const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso);
  const soon = Math.abs(d - Date.now()) < 6 * 864e5;
  return d.toLocaleString([], soon
    ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const mapsLink = (place) => `https://maps.google.com/?q=${encodeURIComponent(place)}`;
const inviteLink = (l) => l.inviteUrl || `${location.origin}${l.invitePath}`;

function toast(msg, isErr = false) {
  toastEl.textContent = msg;
  toastEl.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.className = ''; }, 2600);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(store.token && { authorization: `Bearer ${store.token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && store.token) { store.token = null; go('/login'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function share(url, title) {
  if (navigator.share) {
    try { await navigator.share({ title, text: `Lock in for ${title}`, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { window.prompt('Copy this invite link', url); }
}

// ---- router -----------------------------------------------------------
let cleanup = () => {};
const go = (path) => { location.hash = `#${path}`; };
const routes = [
  [/^\/$/, home], [/^\/login$/, login], [/^\/join\/([^/]+)$/, invite],
  [/^\/lobby\/([^/]+)$/, lobbyPage], [/^\/game\/(\d+)$/, gamePage], [/^\/admin$/, adminPage],
];

async function render() {
  cleanup(); cleanup = () => {};
  const path = location.hash.slice(1) || '/';
  const hit = routes.map(([re, fn]) => [re.exec(path), fn]).find(([m]) => m);
  if (!hit) return go('/');
  const [match, fn] = hit;
  const open = ['login', 'invite'].includes(fn.name);
  if (!open && !store.token) return go('/login');
  try { await fn(...match.slice(1)); }
  catch (e) { screen.innerHTML = `<div class="card banner warn"><div class="t">Something went wrong</div>${esc(e.message)}</div><a class="back" href="#/">← Home</a>`; }
}
window.addEventListener('hashchange', render);

// Invite links are real paths (/join/CODE): hand them to the hash router.
if (location.pathname.startsWith('/join/')) {
  const code = location.pathname.split('/')[2];
  history.replaceState(null, '', '/');
  location.hash = `#/join/${code}`;
}

// ---- shared pieces ----------------------------------------------------
function headerHtml(me) {
  const p = me.player;
  return `<div class="header">
    <div class="avatar">${esc(initials(me.user.name))}</div>
    <div><div class="name">${esc(me.user.name)}</div>
    <div class="record">${p.wins}W &ndash; ${p.losses}L &middot; ${p.games_played} game${p.games_played === 1 ? '' : 's'}</div></div>
    <div class="spacer"></div><span class="tier-badge">${esc(p.tier)}</span></div>`;
}

function rosterLine(l) {
  const names = l.playerNames ?? l.players.map((p) => p.name.split(/\s+/)[0]);
  const n = l.playerCount ?? l.players.length;
  if (!n) return 'Be the first to lock in';
  const shown = names.slice(0, 2).join(', ');
  const more = n - Math.min(2, names.length);
  return `${n} locked in &middot; ${esc(shown)}${more > 0 ? ` + ${more} more` : ''}`;
}

const statusPill = (s) => s === 'open' ? '<span class="pill-open">Open</span>'
  : s === 'live' ? '<span class="pill-live">Live</span>' : '<span class="pill-quiet">Closed</span>';

// The lobby card from the mockup. Join goes to Open once you're in.
function lobbyCard(l, tiers, { joined, canJoin = true } = {}) {
  const tier = tiers.find((t) => t.name === l.tier);
  const where = l.location
    ? `<a href="${mapsLink(l.location)}" target="_blank" rel="noopener">&#128205; ${esc(l.location)} &middot; Get directions</a>` : '';
  return `<div class="card lobby" data-open="${esc(l.join_code)}">
    <div class="lobby-top"><span class="title">&#127936; ${esc(l.name)}</span>${statusPill(l.status)}</div>
    <div class="lobby-meta">${fmtWhen(l.starts_at)}${where ? ` &middot; ${where}` : ''}</div>
    <div class="lobby-meta strong">${rosterLine(l)}</div>
    <div class="lobby-foot">
      <div><div class="entry-label">Entry &middot; win pays ${money(winPays(l.stake_cents, tier.rake_percent))}</div>
      <div class="entry-amount">${money(l.stake_cents)}</div></div>
      <div class="btns">
        <button class="join ghost" data-act="invite" data-code="${esc(l.join_code)}">Invite</button>
        ${joined ? `<button class="join" data-act="open" data-code="${esc(l.join_code)}">Open</button>`
          : canJoin ? `<button class="join" data-act="join" data-code="${esc(l.join_code)}">Join</button>` : ''}
      </div></div></div>`;
}

// ---- screens ----------------------------------------------------------
async function home() {
  const [me, tiers, lobbies, games] = await Promise.all([
    api('GET', '/me'), api('GET', '/tiers'), api('GET', '/lobbies'), api('GET', '/me/games'),
  ]);
  const mine = tiers.find((t) => t.name === me.player.tier);
  const next = tiers.find((t) => t.rank === mine.rank + 1);
  const joined = lobbies.filter((l) => l.joined);
  const open = lobbies.filter((l) => !l.joined && l.tier === mine.name && l.status !== 'closed');
  const active = games.find((g) => ['forming', 'playing', 'pending_confirm', 'contested'].includes(g.status));

  let html = headerHtml(me);
  if (next) {
    const pct = Math.min(100, Math.round((me.player.wins / mine.wins_to_promote) * 100));
    html += `<div class="card"><div class="progress-head"><span class="label">Road to ${cap(next.name)}</span>
      <span class="value">${me.player.wins} of ${mine.wins_to_promote} wins</span></div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      <div class="fine">or ${me.player.games_played} of ${mine.games_to_promote} games played &middot; promotion pays 1 free entry</div></div>`;
  } else {
    html += `<div class="card"><div class="progress-head"><span class="label">You made it</span><span class="value">${cap(mine.name)}</span></div>
      <div class="fine">The top of the ladder.</div></div>`;
  }
  if (active) {
    html += `<a class="card banner link-row" href="#/game/${active.id}" style="display:block;text-decoration:none;color:inherit">
      <div class="t">&#127936; Game in progress</div><div class="fine">${esc(active.lobbyName)} &middot; ${esc(statusText(active.status))} &middot; tap to open</div></a>`;
  }
  if (me.owedCents) {
    html += `<div class="card"><div class="fine">Cash to settle at the run</div>
      <div class="big-money ${me.owedCents > 0 ? 'pos' : 'neg'}">${me.owedCents > 0 ? `You're owed ${money(me.owedCents)}` : `You owe ${money(-me.owedCents)}`}</div></div>`;
  }
  html += `<div class="section">Your lobbies</div>`;
  html += joined.length ? joined.map((l) => lobbyCard(l, tiers, { joined: true })).join('')
    : `<div class="card"><div class="empty">You haven't joined a run yet.</div></div>`;
  if (open.length) html += `<div class="section">Open runs</div>` + open.map((l) => lobbyCard(l, tiers, {})).join('');

  html += `<form data-form="joincode" class="card"><label for="code">Have a join code?</label>
    <div class="row"><input id="code" name="code" placeholder="SUN24" autocapitalize="characters" autocomplete="off" maxlength="10" required>
    <button class="join fixed" style="width:auto;margin:0">Go</button></div></form>`;

  const above = tiers.filter((t) => t.rank > mine.rank);
  if (above.length) {
    html += `<div class="section">The ladder</div>`;
    html += above.map((t, i) => {
      const req = t.rank === mine.rank + 1 ? `${mine.wins_to_promote} wins or ${mine.games_to_promote} games`
        : t.rank === tiers.length ? 'The top' : `Reach ${cap(tiers.find((x) => x.rank === t.rank - 1).name)} first`;
      return `<div class="card locked fade-${Math.min(i + 1, 3)}"><span class="lock">${t.rank === tiers.length ? '&#127942;' : '&#128274;'}</span>
        <div class="info"><div class="tname">${esc(t.name)}</div><div class="tdesc">${stakeRange(t)} lobbies &middot; ${t.rake_percent}% rake</div></div>
        <div class="req">${esc(req)}</div></div>`;
    }).join('');
  }
  if (me.user.isAdmin) html += `<a class="card link-row" href="#/admin">Admin: lobbies and cash <span>&rsaquo;</span></a>`;
  html += `<button class="logout" data-act="logout">Log out</button>`;
  screen.innerHTML = html;
}

function login() {
  const code = store.pendingJoin;
  screen.innerHTML = `<div class="brand"><div class="ball">&#127936;</div><h1>Basketball Royale</h1>
    <p>${code ? `Sign up to lock in your spot (${esc(code)})` : 'Log in or sign up with your phone'}</p></div>
    <form data-form="login" class="card">
      <label for="name">Name <span class="fine">(new accounts)</span></label><input id="name" name="name" autocomplete="name" placeholder="Horatio D.">
      <label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="555 123 4567" required>
      <button class="join">Continue</button></form>
    ${code ? '' : `<form data-form="joincode" class="card"><label for="code">Have a join code?</label>
      <div class="row"><input id="code" name="code" placeholder="SUN24" autocapitalize="characters" maxlength="10" required>
      <button class="join fixed" style="width:auto;margin:0">See run</button></div></form>`}`;
}

// What an invite link opens: the run, its roster, and "I'm in", before any signup.
async function invite(code) {
  const l = await api('GET', `/join/${encodeURIComponent(code)}`).catch(() => null);
  if (!l) { screen.innerHTML = `<div class="brand"><div class="ball">&#129335;</div><h1>No run with that code</h1><p>Check the code with whoever invited you.</p></div><a class="back" href="#/">← Back</a>`; return; }
  const tiers = await api('GET', '/tiers');
  const tier = tiers.find((t) => t.name === l.tier);
  const full = l.players;
  screen.innerHTML = `<div class="brand"><div class="ball">&#127936;</div><h1>You're invited</h1><p>Lock in your spot at the run</p></div>
    <div class="card lobby">
      <div class="lobby-top"><span class="title">&#127936; ${esc(l.name)}</span>${statusPill(l.status)}</div>
      <div class="lobby-meta">${fmtWhen(l.startsAt)}${l.location ? ` &middot; <a href="${mapsLink(l.location)}" target="_blank" rel="noopener">&#128205; ${esc(l.location)} &middot; Get directions</a>` : ''}</div>
      <div class="lobby-meta strong">${l.playerCount ? `${l.playerCount} locked in &middot; ${esc(full.slice(0, 2).join(', '))}${l.playerCount > 2 ? ` + ${l.playerCount - 2} more` : ''}` : 'Be the first to lock in'}</div>
      <div class="lobby-foot"><div><div class="entry-label">Entry &middot; win pays ${money(winPays(l.stakeCents, tier.rake_percent))}</div>
      <div class="entry-amount">${money(l.stakeCents)}</div></div>
      ${l.status === 'closed' ? '<span class="pill-quiet">Closed</span>' : `<button class="join" data-act="imin" data-code="${esc(l.joinCode)}">I'm in</button>`}</div></div>
    <div class="fine" style="text-align:center">Cash stays at the court. The app just keeps score of who owes what.</div>`;
}

async function lobbyPage(code) {
  const [me, tiers, l] = await Promise.all([api('GET', '/me'), api('GET', '/tiers'), api('GET', `/lobbies/${code}`)]);
  const joined = l.players.some((p) => p.id === me.player.id);
  const admin = me.user.isAdmin;
  const unfinished = (g) => ['forming', 'playing', 'pending_confirm', 'contested'].includes(g.status);
  const busy = new Set(l.games.filter(unfinished).flatMap((g) => g.players.map((p) => p.player_id)));

  let html = `<a class="back" href="#/">← Home</a>${lobbyCard(l, tiers, { joined: false, canJoin: !joined && l.status !== 'closed' && me.player.tier === l.tier }).replace(' data-open=', ' data-x=')}
    <div class="card"><div class="fine" style="text-align:center">Join code</div><div class="code-box"><div class="code">${esc(l.join_code)}</div></div></div>
    <div class="section">Who's locked in</div><div class="card">
      ${l.players.length ? `<ul class="roster">${l.players.map((p) => `<li><div class="avatar">${esc(initials(p.name))}</div>${esc(p.name)}${p.id === me.player.id ? ' <span class="fine">(you)</span>' : ''}</li>`).join('')}</ul>` : '<div class="empty">Nobody yet.</div>'}
    </div>`;
  if (l.games.length) {
    html += `<div class="section">Games</div><div class="card">${l.games.map((g) => `<a class="link-row" href="#/game/${g.id}">
      <span>Game ${g.id}${g.team_a_score != null ? ` &middot; ${g.team_a_score}&ndash;${g.team_b_score}` : ''}</span><span class="${gamePill(g.status)}">${esc(statusText(g.status))}</span></a>`).join('')}</div>`;
  }
  if (joined && !l.games.some((g) => unfinished(g) && g.players.some((p) => p.player_id === me.player.id))) {
    html += `<button class="join ghost" style="width:100%" data-act="leave" data-code="${esc(l.join_code)}">Leave this lobby</button>`;
  }
  if (admin) {
    html += `<div class="section">Admin</div><div class="card"><div class="btns">
      ${l.status === 'open' ? `<button class="join green" data-act="lobby-start" data-code="${esc(l.join_code)}">Go live</button>` : ''}
      ${l.status !== 'closed' ? `<button class="join danger" data-act="lobby-close" data-code="${esc(l.join_code)}">Close lobby</button>` : ''}</div></div>`;
    if (l.status !== 'closed') {
      const free = l.players.filter((p) => !busy.has(p.id));
      html += `<form data-form="newgame" data-code="${esc(l.join_code)}" class="card"><div class="progress-head"><span class="label">Form a game</span><span class="fine">pick sides</span></div>
        ${free.length ? free.map((p) => `<div class="pick"><span>${esc(p.name)}</span><select name="p${p.id}"><option value="">Sit</option><option value="a">Team A</option><option value="b">Team B</option></select></div>`).join('')
          : '<div class="empty">Everyone joined is already in a game.</div>'}
        ${free.length ? '<button class="join">Create game</button>' : ''}</form>`;
    }
  }
  screen.innerHTML = html;
}

const statusText = (s) => ({ forming: 'Forming', playing: 'Playing', pending_confirm: 'Confirm score', contested: 'Disputed', locked: 'Final', void: 'Void' }[s] ?? s);
const gamePill = (s) => s === 'contested' ? 'pill-bad' : s === 'locked' ? 'pill-open' : s === 'playing' ? 'pill-live' : 'pill-quiet';

async function gamePage(id) {
  let deadline = null;
  const draw = async () => {
    const [me, g, ledger] = await Promise.all([api('GET', '/me'), api('GET', `/games/${id}`), api('GET', '/me/ledger')]);
    const mine = g.players.find((p) => p.player_id === me.player.id);
    const admin = me.user.isAdmin;
    const team = (t) => `<div class="team ${mine?.team === t ? 'mine' : ''}"><h3>Team ${t.toUpperCase()}${mine?.team === t ? ' &middot; you' : ''}</h3>
      ${g.players.filter((p) => p.team === t).map((p) => `<div class="p">${esc(p.name)}</div>`).join('')}</div>`;
    const lobby = await api('GET', '/lobbies').then((ls) => ls.find((l) => l.id === g.lobby_id));
    deadline = g.status === 'pending_confirm' ? new Date(g.confirm_deadline) : null;

    let html = `<a class="back" href="#/${lobby ? `lobby/${lobby.join_code}` : ''}">← ${lobby ? esc(lobby.name) : 'Home'}</a>
      <div class="lobby-top"><span class="title" style="font-weight:600;font-size:17px;flex:1">Game ${g.id}</span><span class="${gamePill(g.status)}">${esc(statusText(g.status))}</span></div>`;
    if (g.team_a_score != null) {
      html += `<div class="card"><div class="scoreboard"><span class="${g.winner === 'a' ? 'win' : ''}">${g.team_a_score}</span><span class="dash">&ndash;</span><span class="${g.winner === 'b' ? 'win' : ''}">${g.team_b_score}</span></div></div>`;
    }
    html += `<div class="card"><div class="teams">${team('a')}${team('b')}</div></div>`;

    if (g.status === 'forming') {
      html += `<div class="card banner"><div class="t">Waiting to tip off</div>Entry fees are recorded when the game starts.</div>`;
      if (admin) html += `<button class="join" style="width:100%" data-act="game-start" data-id="${g.id}">Start game</button>`;
    } else if (g.status === 'playing') {
      html += `<div class="card banner"><div class="t">Game on</div>When it's over, one player reports the final score.</div>`;
      if (mine || admin) {
        html += `<form data-form="score" data-id="${g.id}" class="card"><div class="score-inputs">
          <div><label>Team A</label><input name="a" type="number" min="0" inputmode="numeric" required></div>
          <div><label>Team B</label><input name="b" type="number" min="0" inputmode="numeric" required></div></div>
          <button class="join">Report final score</button></form>`;
      }
    } else if (g.status === 'pending_confirm') {
      const confirmed = mine && (mine.team === 'a' ? g.confirmed_by_a : g.confirmed_by_b);
      const other = mine && (mine.team === 'a' ? g.confirmed_by_b : g.confirmed_by_a);
      html += `<div class="card banner"><div class="t">Confirm the score</div>
        ${confirmed ? `You confirmed${other ? '' : '. Waiting on the other team.'}` : 'Is this right? One player per team confirms.'}
        <div class="fine" style="margin-top:4px">Locks automatically in <b id="countdown"></b> if nobody disputes it.</div></div>`;
      if (mine) html += `<div class="btns">${confirmed ? '' : `<button class="join green" style="flex:1" data-act="confirm" data-id="${g.id}">Confirm</button>`}<button class="join danger" style="flex:1" data-act="contest" data-id="${g.id}">Dispute</button></div>`;
    } else if (g.status === 'contested') {
      html += `<div class="card banner warn"><div class="t">Score disputed</div>An admin will rule on it. Money is on hold until then.</div>`;
      if (admin) html += `<div class="section">Rule on it</div><div class="btns">
        <button class="join" style="flex:1" data-act="resolve" data-id="${g.id}" data-winner="a">A wins</button>
        <button class="join" style="flex:1" data-act="resolve" data-id="${g.id}" data-winner="b">B wins</button>
        <button class="join ghost" style="flex:1" data-act="resolve" data-id="${g.id}" data-winner="">Void</button></div>`;
    } else if (g.status === 'locked' || g.status === 'void') {
      const rows = ledger.filter((r) => r.game_id === g.id);
      const net = rows.reduce((n, r) => n + r.amount_cents, 0);
      const promo = rows.some((r) => r.type === 'promo_credit');
      if (g.status === 'void') {
        html += `<div class="card banner"><div class="t">Game voided</div>Entry fees refunded. No record changes.</div>`;
      } else if (mine) {
        const won = mine.team === g.winner;
        html += `<div class="card banner ${won ? 'good' : ''}"><div class="t">${won ? 'You won' : 'You lost'}</div>
          <div class="big-money ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${money(net)}</div>
          <div class="fine">${promo ? '&#127881; Promoted! A free entry was credited. ' : ''}Cash settles at the run.</div></div>`;
      }
    }
    screen.innerHTML = html;
    tick();
  };
  const tick = () => {
    const el = document.getElementById('countdown');
    if (!el || !deadline) return;
    const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  await draw();
  const poll = setInterval(() => draw().catch(() => {}), 4000);
  const clock = setInterval(tick, 1000);
  cleanup = () => { clearInterval(poll); clearInterval(clock); };
}

async function adminPage() {
  const [me, tiers, lobbies, balances] = await Promise.all([
    api('GET', '/me'), api('GET', '/tiers'), api('GET', '/lobbies'), api('GET', '/admin/balances').catch(() => null),
  ]);
  if (!me.user.isAdmin || !balances) { screen.innerHTML = `<div class="card banner warn"><div class="t">Admins only</div></div><a class="back" href="#/">← Home</a>`; return; }
  screen.innerHTML = `<a class="back" href="#/">← Home</a><div class="section" style="margin-top:0">New lobby</div>
    <form data-form="newlobby" class="card">
      <label>Name</label><input name="name" value="Sunday run" required>
      <label>Court / address</label><input name="location" placeholder="Rucker Park, 155th St">
      <label>Starts</label><input name="startsAt" type="datetime-local" required>
      <div class="row"><div><label>Tier</label><select name="tier">${tiers.map((t) => `<option value="${t.name}" data-min="${t.min_stake_cents}">${cap(t.name)} (${stakeRange(t)})</option>`).join('')}</select></div>
      <div><label>Entry ($)</label><input name="stake" type="number" step="0.01" min="1" value="5" required></div></div>
      <label>Join code <span class="fine">(blank = generate one)</span></label><input name="joinCode" maxlength="10" autocapitalize="characters">
      <button class="join">Create lobby</button></form>
    <div class="section">Live lobbies</div><div class="card">${lobbies.length ? lobbies.map((l) => `<a class="link-row" href="#/lobby/${esc(l.join_code)}"><span>${esc(l.name)} <span class="fine">${esc(l.join_code)}</span></span>${statusPill(l.status)}</a>`).join('') : '<div class="empty">None open.</div>'}</div>
    <div class="section">Cash to settle</div><div class="card">${balances.length ? balances.map((b) => `<div class="link-row" style="cursor:default"><span>${esc(b.name)}<br>
      <span class="${b.owedCents > 0 ? 'pos' : 'neg'}">${b.owedCents > 0 ? `pay out ${money(b.owedCents)}` : `collect ${money(-b.owedCents)}`}</span></span>
      <button class="join ghost" data-act="settle" data-ids="${b.ledgerIds.join(',')}">Settled</button></div>`).join('') : '<div class="empty">Nobody owes anything.</div>'}</div>`;
}

// ---- events -----------------------------------------------------------
const run = (fn) => fn().catch((e) => toast(e.message, true));
const refresh = () => render();

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], [data-open]');
  if (!el) return;
  if (e.target.closest('a')) return; // maps links etc.
  const { act, code, id, winner, ids } = el.dataset;
  if (!act) { if (el.dataset.open) go(`/lobby/${el.dataset.open}`); return; }
  e.stopPropagation();
  run(async () => {
    switch (act) {
      case 'open': go(`/lobby/${code}`); break;
      case 'join': await api('POST', `/lobbies/${code}/join`); go(`/lobby/${code}`); break;
      case 'leave': await api('POST', `/lobbies/${code}/leave`); toast('Left the lobby'); go('/'); break;
      case 'invite': {
        const l = await api('GET', `/lobbies/${code}`);
        await share(inviteLink(l), l.name); break;
      }
      case 'imin':
        if (!store.token) { store.pendingJoin = code; go('/login'); break; }
        await api('POST', `/lobbies/${code}/join`); go(`/lobby/${code}`); break;
      case 'logout': store.token = null; go('/login'); break;
      case 'lobby-start': await api('POST', `/lobbies/${code}/start`); refresh(); break;
      case 'lobby-close': await api('POST', `/lobbies/${code}/close`); toast('Lobby closed'); go('/admin'); break;
      case 'game-start': await api('POST', `/games/${id}/start`); refresh(); break;
      case 'confirm': await api('POST', `/games/${id}/confirm`); refresh(); break;
      case 'contest': await api('POST', `/games/${id}/contest`); refresh(); break;
      case 'resolve': await api('POST', `/games/${id}/resolve`, { winner: winner || null }); refresh(); break;
      case 'settle': await api('POST', '/admin/ledger/settle', { ledgerIds: ids.split(',').map(Number) }); refresh(); break;
    }
  });
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  run(async () => {
    switch (form.dataset.form) {
      case 'login': {
        const { token } = await api('POST', '/auth/login', { name: f.name?.trim(), phone: f.phone.trim() });
        store.token = token;
        const code = store.pendingJoin;
        store.pendingJoin = null;
        if (code) { await api('POST', `/lobbies/${code}/join`).catch((err) => toast(err.message, true)); go(`/lobby/${code}`); }
        else go('/');
        break;
      }
      case 'joincode': go(`/join/${f.code.trim().toUpperCase()}`); break;
      case 'newlobby': {
        const made = await api('POST', '/lobbies', {
          name: f.name, location: f.location || null, startsAt: f.startsAt, tier: f.tier,
          stakeCents: Math.round(Number(f.stake) * 100), joinCode: f.joinCode || undefined,
        });
        toast(`Lobby created: ${made.join_code}`); go(`/lobby/${made.join_code}`); break;
      }
      case 'newgame': {
        const teams = { a: [], b: [] };
        for (const [k, v] of Object.entries(f)) if (k.startsWith('p') && v) teams[v].push(Number(k.slice(1)));
        const g = await api('POST', `/lobbies/${form.dataset.code}/games`, { teams });
        go(`/game/${g.id}`); break;
      }
      case 'score':
        await api('POST', `/games/${form.dataset.id}/score`, { teamAScore: Number(f.a), teamBScore: Number(f.b) });
        refresh(); break;
    }
  });
});

render();
