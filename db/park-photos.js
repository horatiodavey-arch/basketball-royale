// Player photos of a park. The image files live under DATA_DIR (the
// persistent volume on Railway), not in the repo or the database; the
// park_photos table tracks who took each one and whether an organizer
// has approved it yet.
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, lastId, DATA_DIR } = require('./index');

const PHOTO_DIR = path.join(DATA_DIR, 'park-photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const MAX_WIDTH = 1600;
// Enough for anyone taking a few angles; stops one account from filling
// the volume with photos nobody has reviewed yet.
const MAX_PENDING_PER_PLAYER_PER_PARK = 5;
const FILENAME_PATTERN = /^[a-f0-9]{32}\.jpg$/;

// Whatever the phone sent becomes one upright JPEG no wider than 1600px.
// Re-encoding also drops the photo's metadata (a phone photo carries its
// GPS position and device model), and means only bytes that really decode
// as an image are ever stored or served back.
async function savePhoto(parkId, playerId, buffer) {
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM park_photos WHERE park_id = ? AND player_id = ? AND status = 'pending'")
    .get(parkId, playerId).n;
  if (pending >= MAX_PENDING_PER_PLAYER_PER_PARK) {
    return { ok: false, error: 'You already have photos of this park waiting for review.' };
  }

  let jpeg;
  try {
    jpeg = await sharp(buffer)
      .autoOrient()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (err) {
    return { ok: false, error: "Couldn't read that photo. Try a different one." };
  }

  const filename = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  await fs.promises.writeFile(path.join(PHOTO_DIR, filename), jpeg);
  db.prepare('INSERT INTO park_photos (park_id, player_id, filename) VALUES (?, ?, ?)').run(parkId, playerId, filename);
  return { ok: true, id: lastId(), filename };
}

// The row for a served filename, or null. The pattern check comes first so
// nothing but our own generated names ever reaches the filesystem path.
function getPhotoByFilename(filename) {
  if (!FILENAME_PATTERN.test(filename)) return null;
  return db.prepare('SELECT * FROM park_photos WHERE filename = ?').get(filename) || null;
}

function photoPath(filename) {
  return path.join(PHOTO_DIR, filename);
}

// An approved photo is for everyone. One still waiting for review is only
// for organizers and the player who took it.
function canViewPhoto(photo, viewer) {
  if (photo.status === 'approved') return true;
  return !!viewer && (!!viewer.is_organizer || viewer.player_id === photo.player_id);
}

// Oldest first — the order they came in.
function getPendingPhotos() {
  return db
    .prepare(
      `SELECT ph.id, ph.filename, ph.created_at, p.id AS park_id, p.name AS park_name, p.city AS park_city,
              u.name AS player_name
       FROM park_photos ph
       JOIN parks p ON p.id = ph.park_id
       JOIN players pl ON pl.id = ph.player_id
       JOIN users u ON u.id = pl.user_id
       WHERE ph.status = 'pending'
       ORDER BY ph.created_at ASC, ph.id ASC`
    )
    .all();
}

// parkId -> that park's approved photos (newest first), each flagged if
// it's the current cover. For the organizer's "Set as cover" picker.
function getApprovedPhotosByPark() {
  const rows = db
    .prepare(
      `SELECT ph.id, ph.filename, ph.park_id, u.name AS player_name, (p.cover_photo_id = ph.id) AS is_cover
       FROM park_photos ph
       JOIN parks p ON p.id = ph.park_id
       JOIN players pl ON pl.id = ph.player_id
       JOIN users u ON u.id = pl.user_id
       WHERE ph.status = 'approved'
       ORDER BY ph.created_at DESC, ph.id DESC`
    )
    .all();
  const byPark = new Map();
  for (const row of rows) {
    if (!byPark.has(row.park_id)) byPark.set(row.park_id, []);
    byPark.get(row.park_id).push(row);
  }
  return byPark;
}

// Approving a park's first photo also makes it the cover, so "approved"
// never leaves a park still saying "No photo yet".
function approvePhoto(photoId, organizerPlayerId) {
  const photo = db.prepare('SELECT * FROM park_photos WHERE id = ?').get(photoId);
  if (!photo || photo.status !== 'pending') return { ok: false };
  db.prepare(
    "UPDATE park_photos SET status = 'approved', reviewed_by_player_id = ?, reviewed_at = datetime('now') WHERE id = ?"
  ).run(organizerPlayerId, photoId);
  db.prepare('UPDATE parks SET cover_photo_id = ? WHERE id = ? AND cover_photo_id IS NULL').run(photoId, photo.park_id);
  return { ok: true };
}

function setCoverPhoto(photoId) {
  const photo = db.prepare("SELECT * FROM park_photos WHERE id = ? AND status = 'approved'").get(photoId);
  if (!photo) return { ok: false };
  db.prepare('UPDATE parks SET cover_photo_id = ? WHERE id = ?').run(photoId, photo.park_id);
  return { ok: true };
}

// Rejecting a pending photo and removing an approved one are the same
// thing: the row and the file both go. If it was the cover, the park's
// newest remaining approved photo takes over (or none).
function removePhoto(photoId) {
  const photo = db.prepare('SELECT * FROM park_photos WHERE id = ?').get(photoId);
  if (!photo) return { ok: false };

  const wasCover = db.prepare('SELECT 1 FROM parks WHERE cover_photo_id = ?').get(photoId);
  if (wasCover) {
    const next = db
      .prepare(
        "SELECT id FROM park_photos WHERE park_id = ? AND status = 'approved' AND id != ? ORDER BY created_at DESC, id DESC LIMIT 1"
      )
      .get(photo.park_id, photoId);
    db.prepare('UPDATE parks SET cover_photo_id = ? WHERE cover_photo_id = ?').run(next ? next.id : null, photoId);
  }
  db.prepare('DELETE FROM park_photos WHERE id = ?').run(photoId);
  fs.rm(photoPath(photo.filename), { force: true }, () => {});
  return { ok: true };
}

module.exports = {
  savePhoto,
  getPhotoByFilename,
  photoPath,
  canViewPhoto,
  getPendingPhotos,
  getApprovedPhotosByPark,
  approvePhoto,
  setCoverPhoto,
  removePhoto,
};
