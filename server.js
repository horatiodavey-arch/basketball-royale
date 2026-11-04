const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const path = require('node:path');

const {
  getUserByPhone,
  getPlayerByUserId,
  createUserAndPlayer,
  getPlayerProfile,
  getTiers,
  getOpenLobbies,
  getLobbyRoster,
  isPlayerInGame,
  joinLobby,
  getLobbyById,
} = require('./db/queries');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/signup');
  next();
}

function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

function formatLobbyTime(iso) {
  const d = new Date(iso);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${weekday} ${time}`;
}

// Standard 5v5 pot math from the schema's settlement pseudocode:
// pot = stake x 10 players, rake per tier, split across 5 winners.
function winPayoutCents(stakeCents, rakePercent) {
  const pot = stakeCents * 10;
  const rake = Math.round((pot * rakePercent) / 100);
  return Math.round((pot - rake) / 5);
}

app.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('signup', { error: null, name: '', phone: '' });
});

app.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();

  if (!name || !phone) {
    return res.render('signup', {
      error: 'Enter your name and phone number.',
      name,
      phone,
    });
  }

  let user = getUserByPhone(phone);
  if (user) {
    // Phone already known — courtside sign-up doubles as sign-in.
    req.session.userId = user.id;
    return res.redirect('/');
  }

  const { userId } = createUserAndPlayer(name, phone);
  req.session.userId = userId;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/signup'));
});

app.get('/', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  if (!profile) {
    req.session.destroy(() => res.redirect('/signup'));
    return;
  }

  const tiers = getTiers();
  const lobbies = getOpenLobbies()
    .filter((lobby) => lobby.tier === profile.tier)
    .map((lobby) => {
      const roster = getLobbyRoster(lobby.id);
      const joined = isPlayerInGame(roster.gameId, profile.player_id);
      const otherNames = roster.players
        .filter((p) => p.user_id !== profile.user_id)
        .map((p) => p.name);
      const tierInfo = tiers.find((t) => t.name === lobby.tier);
      return {
        ...lobby,
        rosterCount: roster.players.length,
        rosterNames: otherNames,
        joined,
        startsLabel: formatLobbyTime(lobby.starts_at),
        winPayoutCents: winPayoutCents(lobby.stake_cents, tierInfo.rake_percent),
      };
    });

  const winsNeeded = profile.wins_to_promote;
  const gamesNeeded = profile.games_to_promote;
  let progressPercent = 0;
  if (winsNeeded || gamesNeeded) {
    const winRatio = winsNeeded ? profile.wins / winsNeeded : 0;
    const gameRatio = gamesNeeded ? profile.games_played / gamesNeeded : 0;
    progressPercent = Math.min(100, Math.round(Math.max(winRatio, gameRatio) * 100));
  }
  const nextTier = tiers.find((t) => t.rank === profile.tier_rank + 1);

  res.render('home', {
    profile,
    tiers,
    lobbies,
    initials: initials(profile.name),
    progressPercent,
    winsNeeded,
    gamesNeeded,
    nextTier,
  });
});

app.post('/lobbies/:id/join', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const lobby = getLobbyById(req.params.id);

  if (!profile || !lobby) return res.redirect('/');
  if (lobby.tier !== profile.tier) return res.redirect('/');

  joinLobby(profile.player_id, lobby);
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Basketball Royale running at http://localhost:${PORT}`);
});
