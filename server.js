const express = require('express');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
 
const PORT = parseInt(process.env.PORT || '3000', 10);
const GOAL = parseInt(process.env.GOAL || '50', 10);
const MAX_POINTS = parseInt(process.env.MAX_POINTS || '10', 10);
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
 
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
 
const db = new DatabaseSync(path.join(DATA_DIR, 'petition.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL,
    team_key TEXT NOT NULL UNIQUE,
    photo TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
 
const hasPoints = db.prepare('PRAGMA table_info(signatures)').all().some(c => c.name === 'points');
if (!hasPoints) db.exec('ALTER TABLE signatures ADD COLUMN points INTEGER NOT NULL DEFAULT 0');
 
const stmtList = db.prepare('SELECT id, team, photo, points, created_at FROM signatures ORDER BY id DESC LIMIT 200');
const stmtTotals = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(points), 0) AS s FROM signatures');
const stmtInsert = db.prepare('INSERT INTO signatures (team, team_key, photo, points) VALUES (?, ?, ?, ?)');
const stmtGet = db.prepare('SELECT * FROM signatures WHERE id = ?');
const stmtDelete = db.prepare('DELETE FROM signatures WHERE id = ?');
 
const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};
 
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + EXT[file.mimetype])
  }),
  fileFilter: (req, file, cb) => {
    if (EXT[file.mimetype]) return cb(null, true);
    cb(new Error('Допустимы только JPG, PNG, WEBP и GIF'));
  },
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});
 
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const arr = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 10) return res.status(429).json({ error: 'Слишком часто. Подождите минуту.' });
  arr.push(now);
  hits.set(req.ip, arr);
  next();
}
 
function removeFile(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}
 
function baseUrl(req) {
  return BASE_URL || `${req.protocol}://${req.get('host')}`;
}
 
const app = express();
app.set('trust proxy', true);
 
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
 
app.get('/api/signatures', (req, res) => {
  const t = stmtTotals.get();
  res.json({
    count: Number(t.c),
    totalPoints: Number(t.s),
    goal: GOAL,
    maxPoints: MAX_POINTS,
    items: stmtList.all().map(r => ({
      id: r.id,
      team: r.team,
      photo: r.photo ? '/uploads/' + r.photo : null,
      points: Number(r.points),
      createdAt: r.created_at
    }))
  });
});
 
app.post(
  '/api/sign',
  rateLimit,
  (req, res, next) => {
    upload.single('photo')(req, res, err => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Фото больше 5 МБ' : err.message;
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  (req, res) => {
    const team = String(req.body.team || '').replace(/\s+/g, ' ').trim();
    if (!team) {
      removeFile(req.file);
      return res.status(400).json({ error: 'Введите название команды' });
    }
    if (team.length > 60) {
      removeFile(req.file);
      return res.status(400).json({ error: 'Название длиннее 60 символов' });
    }
    const points = parseInt(req.body.points, 10);
    if (!Number.isInteger(points) || points < 1 || points > MAX_POINTS) {
      removeFile(req.file);
      return res.status(400).json({ error: `Выберите количество баллов от 1 до ${MAX_POINTS}` });
    }
    try {
      const info = stmtInsert.run(team, team.toLowerCase(), req.file ? req.file.filename : null, points);
      const t = stmtTotals.get();
      res.status(201).json({
        id: Number(info.lastInsertRowid),
        count: Number(t.c),
        totalPoints: Number(t.s)
      });
    } catch (e) {
      removeFile(req.file);
      if (/constraint/i.test(String(e.message))) {
        return res.status(409).json({ error: 'Эта команда уже подписала петицию' });
      }
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);
 
app.delete('/api/signatures/:id', (req, res) => {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  const row = stmtGet.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  stmtDelete.run(row.id);
  if (row.photo) fs.unlink(path.join(UPLOADS_DIR, row.photo), () => {});
  res.json({ ok: true });
});
 
app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(baseUrl(req) + '/', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});
 
app.get('/qr.png', async (req, res) => {
  const buf = await QRCode.toBuffer(baseUrl(req) + '/', { width: 800, margin: 2, errorCorrectionLevel: 'M' });
  res.type('image/png').send(buf);
});
 
app.listen(PORT, () => {
  console.log(`Петиция: http://localhost:${PORT}`);
  console.log(`Плакат с QR: http://localhost:${PORT}/poster.html`);
});
