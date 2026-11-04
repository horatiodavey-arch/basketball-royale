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
  getParks,
  getParkById,
  getCourtById,
  getCourtsWithParks,
  getAllPlayers,
  recordGame,
  getSeasonWindow,
  getCrownLevel,
  getLeaderboard,
  CROWN_LEVELS,
} = require('./db/queries');

const app = express();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
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

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// [{id, number, nickname, park_id, park_name}, ...] -> [{parkName, courts}, ...]
// so the <select> template can emit one <optgroup> per park with plain loops.
function groupCourtsByPark(courts) {
  const groups = [];
  for (const court of courts) {
    let group = groups[groups.length - 1];
    if (!group || group.parkId !== court.park_id) {
      group = { parkId: court.park_id, parkName: court.park_name, courts: [] };
      groups.push(group);
    }
    group.courts.push(court);
  }
  return groups;
}

app.get('/games/new', requireAuth, (req, res) => {
  res.render('record-game', {
    courtGroups: groupCourtsByPark(getCourtsWithParks()),
    players: getAllPlayers(),
    error: null,
    form: { courtId: '', teamA: [], teamB: [], scoreA: '', scoreB: '', minutes: '' },
  });
});

app.post('/games', requireAuth, (req, res) => {
  const courtId = Number(req.body.courtId);
  const teamA = toArray(req.body.teamA).map(Number);
  const teamB = toArray(req.body.teamB).map(Number);
  const scoreA = Number(req.body.scoreA);
  const scoreB = Number(req.body.scoreB);
  const minutes = Number(req.body.minutes);

  const court = getCourtById(courtId);
  const overlap = teamA.filter((id) => teamB.includes(id));

  let error = null;
  if (!court) error = 'Pick a court.';
  else if (teamA.length === 0 || teamB.length === 0) error = 'Both teams need at least one player.';
  else if (overlap.length > 0) error = 'A player can only be on one team — remove them from one side.';
  else if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) {
    error = 'Enter a final score — ties aren’t a thing here.';
  } else if (!Number.isInteger(minutes) || minutes <= 0) {
    error = 'Enter how many minutes the game lasted.';
  }

  if (error) {
    return res.render('record-game', {
      courtGroups: groupCourtsByPark(getCourtsWithParks()),
      players: getAllPlayers(),
      error,
      form: {
        courtId: req.body.courtId || '',
        teamA,
        teamB,
        scoreA: req.body.scoreA || '',
        scoreB: req.body.scoreB || '',
        minutes: req.body.minutes || '',
      },
    });
  }

  recordGame({ parkId: court.park_id, courtId, teamA, teamB, scoreA, scoreB, minutes });
  res.redirect(`/board?park=${court.park_id}&scope=court`);
});

app.get('/board', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const parks = getParks();
  const season = getSeasonWindow();

  if (parks.length === 0) {
    return res.render('board', {
      parks: [],
      rows: [],
      scope: 'court',
      selectedPark: null,
      season,
      crownLevels: CROWN_LEVELS,
      profile,
    });
  }

  const scope = req.query.scope === 'city' ? 'city' : 'court';
  const requestedParkId = Number(req.query.park);
  const selectedPark = parks.find((p) => p.id === requestedParkId) || parks[0];
  const rows = getLeaderboard({ scope, parkId: selectedPark.id, seasonStart: season.startSql });

  res.render('board', {
    parks,
    rows,
    scope,
    selectedPark,
    season,
    crownLevels: CROWN_LEVELS,
    profile,
  });
});

app.get('/map', requireAuth, (req, res) => {
  res.render('coming-soon', {
    active: 'map',
    title: 'Map',
    message: 'Finding a run near you and checking in from the map is coming soon.',
    showRecordGameLink: false,
  });
});

app.get('/runs', requireAuth, (req, res) => {
  res.render('coming-soon', {
    active: 'runs',
    title: 'Runs',
    message: 'The next-line queue for a court is coming soon. For now, you can record a game you already played:',
    showRecordGameLink: true,
  });
});

app.get('/profile', requireAuth, (req, res) => {
  res.render('coming-soon', {
    active: 'profile',
    title: 'Profile',
    message: 'Your player profile page is coming soon.',
    showRecordGameLink: false,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Basketball Royale running at http://localhost:${PORT}`);
});
