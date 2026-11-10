const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const path = require('node:path');

const {
  getUserByPhone,
  getPlayerByUserId,
  createUserAndPlayer,
  getPlayerProfile,
  getPlayerProfileByPlayerId,
  getTiers,
  getOpenLobbies,
  getLobbyRoster,
  isPlayerInGame,
  joinLobby,
  getLobbyById,
  getParks,
  getParkById,
  getCourtById,
  getCourtsByPark,
  getSeasonWindow,
  getCrownLevel,
  getLeaderboard,
  getCrownPerks,
  getPlayerSeasonPoints,
  getNextCrownProgress,
  getAllCourtsTimerStatus,
  getParkMapPins,
  getParkSheetDetail,
  CROWN_LEVELS,
  checkIn,
  heartbeat,
  getCourtScreen,
  iGotNext,
  addSquadMembers,
  markLeft,
  addSub,
  declareWinner,
  confirmResult,
  updateParkSettings,
  syncOrganizerFlag,
  logEvent,
  getEventStats,
  getNearbyOpenCourts,
  checkInAtOpenCourt,
  createCourtSuggestion,
  getCourtSuggestions,
  approveCourtSuggestion,
  rejectCourtSuggestion,
  findOrCreateParkAndCourtFromOsm,
  parseScheduledAt,
  createRun,
  getRunById,
  rsvpToRun,
  toggleFollowCourt,
  followCourt,
  getFollowedCourtsForPlayer,
  getNearbyUpcomingRuns,
  OVERPASS_RADIUS_METERS,
  getAllParksForAdmin,
  updateParkAdmin,
  getSuggestedParks,
  getCheckIn,
  getPaidGamesPlayed,
  CLIENT_REPORTED_EVENTS,
  recordActiveDay,
  getFunnel,
} = require('./db/queries');
const { geocodeAddress, fillMissingParkLocations, startBackgroundGeocoding } = require('./db/geocode');
const parkPhotos = require('./db/park-photos');
const { closeFinishedSeasonsIfDue, getTrophies, getTierLadder } = require('./db/trophies');

const app = express();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
// Raised from Express's 100kb default so a suggested court's optional
// photo (sent as a data: URI, not a file upload — no multer/storage
// infra needed for a "demo mode" app) fits comfortably.
app.use(express.json({ limit: '8mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

// Runs for every page and action (static files were already served above).
app.use((req, res, next) => {
  // A season that has ended gets its trophies handed out before anything
  // reads standings — a no-op except the first request of a new season.
  closeFinishedSeasonsIfDue();
  // The ROYALE header is on every page and shows "Crowns reset in N days".
  res.locals.season = getSeasonWindow();
  if (req.session.userId) recordActiveDay(req.session.userId);
  next();
});

// A city only a lookup can supply (a park made from an OpenStreetMap pin
// or an approved suggestion has coordinates but no address) is filled in
// behind the scenes — the request that created the park doesn't wait.
function fillParkLocationsInBackground() {
  fillMissingParkLocations().catch(() => {});
}

// A form field that should be a number, where blank means "not set" —
// Number('') is 0, which would quietly pin a park at latitude zero.
function optionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/signup');
  next();
}

function requireOrganizer(req, res, next) {
  const profile = getPlayerProfile(req.session.userId);
  if (!profile || !profile.is_organizer) return res.redirect('/runs');
  next();
}

// The source page a tracked tap happened on, from the Referer header —
// falls back to the given default when it's missing (e.g. no JS/privacy
// settings strip it) rather than leaving the event's page blank.
function pagePathFromReferer(req, fallback) {
  const ref = req.get('Referer');
  if (!ref) return fallback;
  try {
    return new URL(ref).pathname;
  } catch {
    return fallback;
  }
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

// A run's scheduled_at is stored "YYYY-MM-DD HH:MM:00", not full ISO —
// parse it as a local wall-clock time, same as formatLobbyTime above.
function formatRunTime(scheduledAt) {
  return formatLobbyTime(scheduledAt.replace(' ', 'T'));
}

// Only a same-site relative path is ever followed after signup — never an
// absolute/protocol-relative URL, so a crafted returnTo can't redirect
// off this app.
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

// Standard 5v5 pot math from the schema's settlement pseudocode:
// pot = stake x 10 players, rake per tier, split across 5 winners.
function winPayoutCents(stakeCents, rakePercent) {
  const pot = stakeCents * 10;
  const rake = Math.round((pot * rakePercent) / 100);
  return Math.round((pot - rake) / 5);
}

app.get('/signup', (req, res) => {
  const returnTo = safeReturnTo(req.query.returnTo);
  if (req.session.userId) return res.redirect(returnTo || '/');
  res.render('signup', { error: null, name: '', phone: '', returnTo });
});

app.post('/signup', (req, res) => {
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const returnTo = safeReturnTo(req.body.returnTo);

  if (!name || !phone) {
    return res.render('signup', {
      error: 'Enter your name and phone number.',
      name,
      phone,
      returnTo,
    });
  }

  let user = getUserByPhone(phone);
  if (user) {
    // Phone already known — courtside sign-up doubles as sign-in.
    req.session.userId = user.id;
    syncOrganizerFlag(phone);
    return res.redirect(returnTo || '/');
  }

  const { userId } = createUserAndPlayer(name, phone);
  req.session.userId = userId;
  syncOrganizerFlag(phone);
  res.redirect(returnTo || '/');
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

  const season = getSeasonWindow();
  const totalPoints = getPlayerSeasonPoints(profile.player_id, season.startSql);
  const crown = getCrownLevel(totalPoints);
  const nextCrown = getNextCrownProgress(totalPoints);
  const parks = getParks();

  if (parks.length === 0) {
    return res.render('home', {
      active: 'map',
      profile,
      season,
      totalPoints,
      crown,
      nextCrown,
      pins: [],
      selectedPark: null,
      sheet: null,
    });
  }

  const pins = getParkMapPins(season.startSql);
  const requestedParkId = Number(req.query.park);
  let selectedPark = parks.find((p) => p.id === requestedParkId);
  if (!selectedPark) {
    // No explicit pick (or an invalid one) — until the client's own
    // geolocation can jump to the true nearest park, guess the most
    // useful one: whichever has people on it right now, not a fixed
    // park picked some other way.
    const mostActive = pins.slice().sort((a, b) => (b.activeCount + b.liveCount) - (a.activeCount + a.liveCount))[0];
    selectedPark = parks.find((p) => p.id === mostActive.id) || parks[0];
  }
  const sheet = getParkSheetDetail(selectedPark.id, season.startSql, profile.player_id);

  res.render('home', {
    active: 'map',
    profile,
    season,
    totalPoints,
    crown,
    nextCrown,
    pins,
    selectedPark,
    sheet,
    formatRunTime,
    canAddPhoto: canAddParkPhoto(profile, selectedPark.id),
  });
});

// Only someone who's actually at the park can add a photo of it; an
// organizer can from anywhere.
function canAddParkPhoto(profile, parkId) {
  return !!profile.is_organizer || !!getCheckIn(profile.player_id, parkId);
}

app.get('/how-it-works', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, 'how_it_works', pagePathFromReferer(req, '/'));
  const season = getSeasonWindow();
  res.render('how-it-works', {
    active: 'map',
    crownLevels: CROWN_LEVELS,
    perks: getCrownPerks(profile.player_id, season.startSql),
    ladder: getTierLadder(profile),
  });
});

app.get('/lobbies', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, 'view_lobbies', pagePathFromReferer(req, '/runs'));
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

  // Rank-ups are "N paid games or trophies". Only the paid-games half has
  // a number players can see — the trophy count needed isn't shown yet.
  const paidGames = getPaidGamesPlayed(profile.player_id);
  const paidGamesNeeded = profile.games_to_promote;
  const progressPercent = paidGamesNeeded
    ? Math.min(100, Math.round((paidGames / paidGamesNeeded) * 100))
    : 0;
  const nextTier = tiers.find((t) => t.rank === profile.tier_rank + 1);

  res.render('lobbies', {
    active: 'runs',
    profile,
    tiers,
    lobbies,
    initials: initials(profile.name),
    progressPercent,
    paidGames,
    paidGamesNeeded,
    nextTier,
  });
});

app.post('/lobbies/:id/join', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const lobby = getLobbyById(req.params.id);

  if (!profile || !lobby) return res.redirect('/lobbies');
  if (lobby.tier !== profile.tier) return res.redirect('/lobbies');

  joinLobby(profile.player_id, lobby);
  res.redirect('/lobbies');
});

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

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

// The home screen (/) is the map now — keep the old URL working.
app.get('/map', requireAuth, (req, res) => res.redirect('/'));

app.get('/runs', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const season = getSeasonWindow();
  res.render('runs', {
    active: 'runs',
    parks: getParks(),
    profile,
    followedCourts: getFollowedCourtsForPlayer(profile.player_id, season.startSql),
    suggestedParks: getSuggestedParks(season.startSql, profile.player_id),
    formatRunTime,
  });
});

// Must come before /runs/:id so "new" isn't swallowed as a run id.
app.get('/runs/new', requireAuth, (req, res) => {
  const courtId = req.query.courtId ? Number(req.query.courtId) : null;
  const osmId = req.query.osmId || null;
  let courtName = null;
  let parkName = null;
  let parkCity = null;

  if (courtId) {
    const court = getCourtById(courtId);
    if (!court) return res.redirect('/runs');
    const park = getParkById(court.park_id);
    courtName = court.nickname || `Court ${court.number}`;
    parkName = park.name;
    parkCity = park.city;
  } else if (!osmId) {
    return res.redirect('/runs');
  }

  res.render('run-new', {
    active: 'runs',
    courtId,
    courtName,
    parkName,
    parkCity,
    osmId,
    osmName: req.query.name || '',
    osmLat: req.query.lat || '',
    osmLng: req.query.lng || '',
    error: req.query.error || null,
  });
});

app.post('/runs', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  let courtId = req.body.courtId ? Number(req.body.courtId) : null;

  if (!courtId && req.body.osmId) {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.redirect('/runs');
    courtId = findOrCreateParkAndCourtFromOsm(String(req.body.osmId), req.body.name, lat, lng).courtId;
    fillParkLocationsInBackground();
  }
  if (!courtId) return res.redirect('/runs');

  const scheduledAt = parseScheduledAt(req.body.scheduledAt);
  if (!scheduledAt) {
    const back = `/runs/new?courtId=${courtId}&error=${encodeURIComponent('Pick a date and time.')}`;
    return res.redirect(back);
  }

  const runId = createRun(courtId, profile.player_id, scheduledAt, req.body.note);
  logEvent(profile.player_id, 'start_a_run', pagePathFromReferer(req, '/runs/new'));
  res.redirect(`/runs/${runId}`);
});

// Deliberately not requireAuth — a shared run link has to work for
// someone who isn't signed in yet; they get a "sign up to RSVP" prompt
// instead of a bounce straight to /signup with no way back.
app.get('/runs/:id', (req, res) => {
  const profile = req.session.userId ? getPlayerProfile(req.session.userId) : null;
  const run = getRunById(Number(req.params.id), profile ? profile.player_id : null);
  if (!run) return res.redirect('/runs');
  res.render('run', { active: 'runs', run, profile, formatRunTime });
});

app.post('/runs/:id/coming', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, 'im_coming', pagePathFromReferer(req, `/runs/${req.params.id}`));
  rsvpToRun(Number(req.params.id), profile.player_id);
  res.redirect(`/runs/${req.params.id}`);
});

app.post('/courts/:courtId/follow', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const result = toggleFollowCourt(profile.player_id, Number(req.params.courtId));
  // The same button unfollows; only the tap that follows is the event.
  if (result.following) logEvent(profile.player_id, 'follow_court', pagePathFromReferer(req, '/runs'));
  res.redirect(req.get('Referer') || '/runs');
});
// For taps that never reach a route of their own (an Invite button only
// opens the phone's share sheet), reported by the page itself.
app.post('/api/events', requireAuth, (req, res) => {
  const name = req.body && req.body.name;
  if (!CLIENT_REPORTED_EVENTS.includes(name)) {
    return res.status(400).json({ ok: false, error: 'Unknown event.' });
  }
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, name, pagePathFromReferer(req, '/'));
  res.json({ ok: true });
});

app.get('/api/nearby-runs', requireAuth, (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: 'lat/lng required.' });
  }
  const { runs, nearestCourt } = getNearbyUpcomingRuns(lat, lng, OVERPASS_RADIUS_METERS);
  res.json({
    ok: true,
    runs: runs.map((r) => ({ ...r, timeLabel: formatRunTime(r.scheduledAt) })),
    nearestCourt,
  });
});

app.get('/parks/:parkId', requireAuth, (req, res) => {
  const courts = getCourtsByPark(Number(req.params.parkId));
  if (courts.length === 0) return res.redirect('/runs');
  res.redirect(`/parks/${req.params.parkId}/courts/${courts[0].id}`);
});

app.get('/parks/:parkId/courts/:courtId', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const court = getCourtById(req.params.courtId);
  if (!court || court.park_id !== Number(req.params.parkId)) return res.redirect('/runs');

  const screen = getCourtScreen(court.id, profile.player_id);
  const countdownEndsAtIso =
    screen.liveGame && screen.liveGame.status === 'countdown'
      ? new Date(screen.liveGame.countdown_ends_at + 'Z').toISOString()
      : null;

  res.render('court', {
    ...screen,
    profile,
    active: 'runs',
    countdownEndsAtIso,
    error: req.query.error || null,
    formatRunTime,
    canAddPhoto: !!profile.is_organizer || screen.checkedIn,
  });
});

app.post('/parks/:parkId/check-in', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, 'check_in', pagePathFromReferer(req, '/'));
  const { lat, lng, accuracy } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ ok: false, error: 'Location not available.' });
  }
  res.json(checkIn(profile.player_id, Number(req.params.parkId), lat, lng, accuracy));
});

// A photo of the park, straight from the phone's camera. The body is the
// image itself (not a form), so it's parsed here rather than by the JSON
// parser above; whatever arrives is resized and re-encoded before it's
// kept. It waits for an organizer's approval before anyone else sees it.
app.post(
  '/parks/:parkId/photos',
  requireAuth,
  express.raw({ type: 'image/*', limit: '15mb' }),
  async (req, res) => {
    const profile = getPlayerProfile(req.session.userId);
    const park = getParkById(Number(req.params.parkId));
    if (!park) return res.status(404).json({ ok: false, error: 'Park not found.' });

    logEvent(profile.player_id, 'add_park_photo', pagePathFromReferer(req, `/parks/${park.id}`));
    if (!canAddParkPhoto(profile, park.id)) {
      return res.status(403).json({ ok: false, error: 'Check in at this park to add a photo.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ ok: false, error: 'No photo received.' });
    }

    const result = await parkPhotos.savePhoto(park.id, profile.player_id, req.body);
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, message: 'Thanks — sent to the organizers for review.' });
  }
);

// Deliberately not requireAuth: an approved photo is as public as the
// park. One still waiting for review is served only to organizers and
// the player who took it — to everyone else it doesn't exist.
app.get('/park-photos/:filename', (req, res) => {
  const photo = parkPhotos.getPhotoByFilename(req.params.filename);
  const viewer = req.session.userId ? getPlayerProfile(req.session.userId) : null;
  if (!photo || !parkPhotos.canViewPhoto(photo, viewer)) return res.status(404).end();
  res.set('Cache-Control', photo.status === 'approved' ? 'public, max-age=604800' : 'private, no-store');
  res.sendFile(parkPhotos.photoPath(photo.filename));
});

app.post('/parks/:parkId/heartbeat', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const { lat, lng } = req.body;
  res.json(heartbeat(profile.player_id, Number(req.params.parkId), lat, lng));
});

// OSM-sourced basketball courts near the player, not yet in our own
// parks table — the map's lighter "Open court" pins. Looked up server-
// side (and cached) so the Overpass API never sees the browser directly.
app.get('/api/nearby-courts', requireAuth, async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: 'lat/lng required.' });
  }
  const courts = await getNearbyOpenCourts(lat, lng);
  res.json({ ok: true, courts });
});

// First check-in at one of those pins creates the real park behind it.
app.post('/open-courts/check-in', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, 'check_in', pagePathFromReferer(req, '/'));
  const { osmId, name, lat, lng, playerLat, playerLng, accuracy } = req.body;
  if (!osmId || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ ok: false, error: 'Missing court location.' });
  }
  res.json(checkInAtOpenCourt(profile.player_id, String(osmId), name, lat, lng, playerLat, playerLng, accuracy));
  fillParkLocationsInBackground();
});

// Following an OSM-sourced court materializes it the same way check-in
// does, then always follows (not a toggle — unfollowing an already-real
// court happens from its own court screen instead).
app.post('/open-courts/follow', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const { osmId, name, lat, lng } = req.body;
  if (!osmId || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ ok: false, error: 'Missing court location.' });
  }
  logEvent(profile.player_id, 'follow_court', pagePathFromReferer(req, '/'));
  const { courtId, parkId } = findOrCreateParkAndCourtFromOsm(String(osmId), name, lat, lng);
  res.json({ ...followCourt(profile.player_id, courtId), courtId, parkId });
  fillParkLocationsInBackground();
});

app.post('/court-suggestions', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, 'suggest_court', pagePathFromReferer(req, '/'));
  const name = (req.body.name || '').trim();
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: 'A name and a dropped pin are both required.' });
  }
  const photo = req.body.photo;
  // Optional, and only ever a data: image URI the client itself encoded —
  // never a remote URL (that would make this an SSRF-style fetch vector)
  // or arbitrary text stored where a page later renders it as a link.
  const photoUrl = typeof photo === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(photo) ? photo : null;
  res.json(createCourtSuggestion(profile.player_id, name, lat, lng, photoUrl));
});

app.post('/parks/:parkId/settings', requireAuth, (req, res) => {
  const gameTarget = Number(req.body.gameTarget);
  const betweenGamesMinutes = Number(req.body.betweenGamesMinutes);
  const checkInRadiusMeters = Number(req.body.checkInRadiusMeters);
  const leaveRadiusMeters = Number(req.body.leaveRadiusMeters);
  const valid =
    Number.isInteger(gameTarget) && gameTarget > 0 &&
    Number.isInteger(betweenGamesMinutes) && betweenGamesMinutes > 0 &&
    Number.isInteger(checkInRadiusMeters) && checkInRadiusMeters > 0 &&
    Number.isInteger(leaveRadiusMeters) && leaveRadiusMeters >= checkInRadiusMeters;
  if (valid) {
    // Stored in seconds (the countdown math throughout db/queries.js
    // works in seconds) — only the organizer-facing form is in minutes.
    updateParkSettings(Number(req.params.parkId), {
      gameTarget,
      betweenGamesSeconds: betweenGamesMinutes * 60,
      checkInRadiusMeters,
      leaveRadiusMeters,
    });
  }
  res.redirect(req.get('Referer') || '/runs');
});

// Actions below redirect back to the referring court screen either way
// — on failure, with ?error=... so the captain sees why nothing happened
// instead of a silent no-op.
function redirectWithResult(req, res, result, fallbackPath) {
  const base = req.get('Referer') || fallbackPath;
  if (result.ok) return res.redirect(base);
  const url = new URL(base, `${req.protocol}://${req.get('host')}`);
  url.searchParams.set('error', result.error || 'That action failed.');
  res.redirect(url.pathname + url.search);
}

app.post('/courts/:courtId/next', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  logEvent(profile.player_id, 'i_got_next', pagePathFromReferer(req, '/runs'));
  const court = getCourtById(req.params.courtId);
  const result = iGotNext(Number(req.params.courtId), profile.player_id);
  // Always lands on the court screen (not back to wherever the button was
  // tapped from, e.g. home) — that's where squad-building continues.
  const courtUrl = `/parks/${court.park_id}/courts/${court.id}`;
  if (result.ok) return res.redirect(courtUrl);
  res.redirect(`${courtUrl}?error=${encodeURIComponent(result.error || 'That action failed.')}`);
});

app.post('/next_line/:id/members', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const playerIds = toArray(req.body.playerIds).map(Number);
  const result = addSquadMembers(Number(req.params.id), playerIds, profile.player_id);
  redirectWithResult(req, res, result, '/runs');
});

app.post('/live_games/:id/left', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const result = markLeft(Number(req.params.id), Number(req.body.playerId), profile.player_id);
  redirectWithResult(req, res, result, '/runs');
});

app.post('/live_games/:id/sub', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const result = addSub(Number(req.params.id), req.body.team, Number(req.body.playerId), profile.player_id);
  redirectWithResult(req, res, result, '/runs');
});

app.post('/live_games/:id/declare', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const result = declareWinner(Number(req.params.id), req.body.team, profile.player_id);
  redirectWithResult(req, res, result, '/runs');
});

app.post('/live_games/:id/confirm', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  const result = confirmResult(Number(req.params.id), profile.player_id);
  redirectWithResult(req, res, result, '/runs');
});

app.get('/profile', requireAuth, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  res.redirect(`/players/${profile.player_id}`);
});

app.get('/players/:id', requireAuth, (req, res) => {
  const viewer = getPlayerProfile(req.session.userId);
  const player = getPlayerProfileByPlayerId(Number(req.params.id));
  if (!player) return res.redirect('/profile');

  // Only a genuine leaderboard tap, not every visit to this page (e.g.
  // your own profile via the bottom nav), counts as this event.
  if (req.query.from === 'board') {
    logEvent(viewer.player_id, 'leaderboard_player_tap', '/board');
  }

  const season = getSeasonWindow();
  const points = getPlayerSeasonPoints(player.player_id, season.startSql);
  const isSelf = player.player_id === viewer.player_id;

  res.render('player-profile', {
    active: 'profile',
    isSelf,
    player,
    points,
    crown: getCrownLevel(points),
    perks: getCrownPerks(player.player_id, season.startSql),
    season,
    initials: initials(player.name),
    trophies: getTrophies(player.player_id),
    // The ladder is "where am I" — shown on your own profile only.
    ladder: isSelf ? getTierLadder(player) : null,
  });
});

app.get('/admin', requireAuth, requireOrganizer, (req, res) => {
  res.redirect('/admin/stats');
});

app.get('/admin/timer', requireAuth, requireOrganizer, (req, res) => {
  res.render('admin-timer', { active: '', courts: getAllCourtsTimerStatus() });
});

app.get('/admin/stats', requireAuth, requireOrganizer, (req, res) => {
  res.render('admin-stats', { active: '', events: getEventStats(), funnel: getFunnel() });
});

app.get('/admin/courts', requireAuth, requireOrganizer, (req, res) => {
  res.render('admin-courts', {
    active: '',
    suggestions: getCourtSuggestions(),
    parks: getAllParksForAdmin(),
    pendingPhotos: parkPhotos.getPendingPhotos(),
    approvedPhotos: parkPhotos.getApprovedPhotosByPark(),
  });
});

// "Find on map": turns the address an organizer typed into a pin they
// can then drag onto the courts. Organizer-only, so this can't be used
// as an open relay to the geocoder.
app.get('/admin/geocode', requireAuth, requireOrganizer, async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address) return res.status(400).json({ ok: false, error: 'Type an address first.' });

  const result = await geocodeAddress(address);
  if (result.ok) return res.json(result);
  res.json({
    ok: false,
    error:
      result.reason === 'unavailable'
        ? "The address lookup isn't reachable right now. Tap the map to place the pin yourself."
        : "Couldn't find that address. Check it, or tap the map to place the pin yourself.",
  });
});

app.post('/admin/photos/:id/approve', requireAuth, requireOrganizer, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  parkPhotos.approvePhoto(Number(req.params.id), profile.player_id);
  res.redirect('/admin/courts');
});

app.post('/admin/photos/:id/cover', requireAuth, requireOrganizer, (req, res) => {
  parkPhotos.setCoverPhoto(Number(req.params.id));
  res.redirect('/admin/courts');
});

// Rejects a photo still waiting for review, or takes down an approved one.
app.post('/admin/photos/:id/remove', requireAuth, requireOrganizer, (req, res) => {
  parkPhotos.removePhoto(Number(req.params.id));
  res.redirect('/admin/courts');
});

app.post('/admin/courts/:id/approve', requireAuth, requireOrganizer, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  approveCourtSuggestion(Number(req.params.id), profile.player_id);
  fillParkLocationsInBackground();
  res.redirect('/admin/courts');
});

app.post('/admin/courts/:id/reject', requireAuth, requireOrganizer, (req, res) => {
  const profile = getPlayerProfile(req.session.userId);
  rejectCourtSuggestion(Number(req.params.id), profile.player_id);
  res.redirect('/admin/courts');
});

app.post('/admin/parks/:id/update', requireAuth, requireOrganizer, async (req, res) => {
  const name = (req.body.name || '').trim();
  const location = (req.body.location || '').trim();
  let city = (req.body.city || '').trim();
  let lat = optionalNumber(req.body.lat);
  let lng = optionalNumber(req.body.lng);
  const checkInRadiusMeters = Number(req.body.checkInRadiusMeters);
  const leaveRadiusMeters = Number(req.body.leaveRadiusMeters);
  const valid =
    name &&
    Number.isInteger(checkInRadiusMeters) && checkInRadiusMeters > 0 &&
    Number.isInteger(leaveRadiusMeters) && leaveRadiusMeters >= checkInRadiusMeters;
  if (!valid) return res.redirect('/admin/courts');

  // Saved with an address but no pin placed: look the address up so the
  // park still lands on the map. (If that fails it's saved pin-less, and
  // the card says so.)
  if (lat === null || lng === null) {
    lat = null;
    lng = null;
    const found = location ? await geocodeAddress(location) : { ok: false };
    if (found.ok) {
      lat = found.lat;
      lng = found.lng;
      city = city || found.city || '';
    }
  }

  updateParkAdmin(Number(req.params.id), {
    name,
    location,
    city,
    lat,
    lng,
    checkInRadiusMeters,
    leaveRadiusMeters,
    isSuggested: req.body.isSuggested === 'on',
  });
  res.redirect('/admin/courts');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Basketball Royale running at http://localhost:${PORT}`);
  // After the port is open, never before: a slow or unreachable geocoder
  // must not hold up the app starting.
  startBackgroundGeocoding();
});
