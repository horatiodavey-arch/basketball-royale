// "You're up next" push alerts: the sending side. It only reads the line and
// records what it sent; it never changes the queue, check-ins or results.
const webpush = require('web-push');
const { db } = require('./index');
const { getCourtById, getParkById, getCheckIn, logEvent } = require('./queries');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const CONFIGURED = !!(PUBLIC_KEY && PRIVATE_KEY);
if (CONFIGURED) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
let warnedUnconfigured = false;

function pushPublicKey() {
  return PUBLIC_KEY || null;
}

function saveSubscription(playerId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return false;
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
  db.prepare('INSERT INTO push_subscriptions (player_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)').run(
    playerId,
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth
  );
  return true;
}

function removeSubscription(playerId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE player_id = ? AND endpoint = ?').run(playerId, endpoint);
}

function subscriptionsFor(playerId) {
  return db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE player_id = ?').all(playerId);
}

// The squad first in line on a court, or null when nobody is waiting.
function firstWaitingSquadId(courtId) {
  const row = db
    .prepare(`SELECT id FROM next_line WHERE court_id = ? AND status = 'waiting' ORDER BY position ASC LIMIT 1`)
    .get(courtId);
  return row ? row.id : null;
}

// Ids of the squads waiting on a court, in line order.
function waitingSquadIds(courtId) {
  return db
    .prepare(`SELECT id FROM next_line WHERE court_id = ? AND status = 'waiting' ORDER BY position ASC`)
    .all(courtId)
    .map((r) => r.id);
}

function courtIdForLiveGame(liveGameId) {
  const row = db.prepare('SELECT court_id FROM live_games WHERE id = ?').get(liveGameId);
  return row ? row.court_id : null;
}

// Player ids on a squad: the captain and the members.
function squadPlayerIds(nextLineId) {
  return db
    .prepare(
      `SELECT captain_player_id AS playerId FROM next_line WHERE id = ?
       UNION
       SELECT player_id AS playerId FROM next_line_members WHERE next_line_id = ?`
    )
    .all(nextLineId, nextLineId)
    .map((r) => r.playerId);
}

// Tells each player on the squad now first in line who is still checked in at
// the park and has notifications on. Once per player per spot: the spot is the
// next_line id, so the same squad is not alerted twice.
async function notifyUpNext(courtId, nextLineId) {
  if (!CONFIGURED) {
    if (!warnedUnconfigured) {
      console.warn('Up-next alerts are off: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set.');
      warnedUnconfigured = true;
    }
    return 0;
  }
  const court = getCourtById(courtId);
  if (!court) return 0;
  const park = getParkById(court.park_id);
  const payload = JSON.stringify({
    title: "You're up next",
    body: `You're up next at ${park.name}. Get ready.`,
    url: '/todays-run',
  });

  let sent = 0;
  for (const playerId of squadPlayerIds(nextLineId)) {
    if (!getCheckIn(playerId, park.id)) continue;
    const subs = subscriptionsFor(playerId);
    if (subs.length === 0) continue;
    // Claim the spot first, so a repeat call for the same spot does nothing.
    const claimed = db
      .prepare('INSERT OR IGNORE INTO up_next_alerts (next_line_id, player_id) VALUES (?, ?)')
      .run(nextLineId, playerId);
    if (claimed.changes === 0) continue;

    let delivered = false;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 600 }
        );
        delivered = true;
      } catch (err) {
        // The browser no longer has this subscription: forget it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
      }
    }
    if (delivered) {
      logEvent(playerId, 'push_sent_up_next', '/todays-run', park.id);
      sent++;
    } else {
      // Nothing reached the player: release the claim so a later attempt can retry.
      db.prepare('DELETE FROM up_next_alerts WHERE next_line_id = ? AND player_id = ?').run(nextLineId, playerId);
    }
  }
  return sent;
}

module.exports = {
  pushPublicKey,
  saveSubscription,
  removeSubscription,
  firstWaitingSquadId,
  waitingSquadIds,
  courtIdForLiveGame,
  notifyUpNext,
};
