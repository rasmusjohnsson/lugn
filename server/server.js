// Lugn — Web Push backend
// A small Express server that:
//   - Receives push subscriptions from the PWA
//   - Stores scheduled notifications per subscription
//   - Sends them via Web Push at the right time
//
// Storage: SQLite (better-sqlite3). VAPID keys are generated on first run
// and persisted to disk; the public key is exposed via /vapid-public-key.

'use strict';

const express = require('express');
const cors = require('cors');
const webPush = require('web-push');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = process.env.LUGN_DATA_DIR || path.join(__dirname, 'data');
const VAPID_SUBJECT = process.env.LUGN_VAPID_SUBJECT || 'mailto:lugn@example.com';
const ALLOWED_ORIGINS = (process.env.LUGN_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

// ---------- Storage setup ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'lugn.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id TEXT NOT NULL,
    tag TEXT,
    title TEXT NOT NULL,
    body TEXT,
    send_at INTEGER NOT NULL,
    sent INTEGER DEFAULT 0,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(sent, send_at);
  CREATE INDEX IF NOT EXISTS idx_schedules_sub ON schedules(subscription_id);
`);

// ---------- VAPID keys ----------
// Priority: env vars > saved file > newly generated
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
let vapid;
if (process.env.LUGN_VAPID_PUBLIC_KEY && process.env.LUGN_VAPID_PRIVATE_KEY) {
  vapid = {
    publicKey: process.env.LUGN_VAPID_PUBLIC_KEY,
    privateKey: process.env.LUGN_VAPID_PRIVATE_KEY
  };
  console.log('Using VAPID keys from environment.');
} else if (fs.existsSync(VAPID_FILE)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapid = webPush.generateVAPIDKeys();
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2)); } catch {}
  console.log('Generated new VAPID keys.');
  console.log('IMPORTANT — copy these to LUGN_VAPID_PUBLIC_KEY and LUGN_VAPID_PRIVATE_KEY');
  console.log('environment variables to keep them stable across redeploys:');
  console.log(JSON.stringify(vapid, null, 2));
}
webPush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin or curl
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed: ' + origin));
  }
}));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/vapid-public-key', (req, res) => res.json({ key: vapid.publicKey }));

// Subscribe (or refresh existing subscription by endpoint)
app.post('/subscribe', (req, res) => {
  const sub = req.body && req.body.subscription;
  const ua = (req.body && req.body.userAgent) || req.headers['user-agent'] || '';
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM subscriptions WHERE endpoint = ?').get(sub.endpoint);
  if (existing) {
    db.prepare('UPDATE subscriptions SET p256dh=?, auth=?, user_agent=?, last_seen_at=? WHERE id=?')
      .run(sub.keys.p256dh, sub.keys.auth, ua.slice(0, 200), now, existing.id);
    return res.json({ subscriptionId: existing.id });
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO subscriptions (id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua.slice(0, 200), now, now);
  res.json({ subscriptionId: id });
});

// Replace all upcoming scheduled notifications for a subscription
// Body: { subscriptionId, items: [{ tag, title, body, sendAt }] }
app.post('/schedule', (req, res) => {
  const { subscriptionId, items } = req.body || {};
  if (!subscriptionId || !Array.isArray(items)) {
    return res.status(400).json({ error: 'expected { subscriptionId, items: [] }' });
  }
  const sub = db.prepare('SELECT id FROM subscriptions WHERE id = ?').get(subscriptionId);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM schedules WHERE subscription_id = ? AND sent = 0').run(subscriptionId);
    const ins = db.prepare('INSERT INTO schedules (subscription_id, tag, title, body, send_at) VALUES (?, ?, ?, ?, ?)');
    for (const it of items) {
      if (!it || !it.title || !it.sendAt) continue;
      const sendAt = Number(it.sendAt);
      if (!Number.isFinite(sendAt) || sendAt < Date.now() - 5 * 60_000) continue;
      ins.run(
        subscriptionId,
        (it.tag || '').slice(0, 120) || null,
        String(it.title).slice(0, 120),
        (it.body ? String(it.body) : '').slice(0, 240),
        sendAt
      );
    }
    db.prepare('UPDATE subscriptions SET last_seen_at = ? WHERE id = ?').run(Date.now(), subscriptionId);
  });
  tx();
  const count = db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE subscription_id = ? AND sent = 0').get(subscriptionId).n;
  res.json({ ok: true, scheduled: count });
});

// Clear scheduled notifications and remove subscription
app.delete('/subscribe/:subscriptionId', (req, res) => {
  const id = req.params.subscriptionId;
  db.prepare('DELETE FROM schedules WHERE subscription_id = ?').run(id);
  db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Scheduler ----------
async function deliverDue() {
  const now = Date.now();
  const due = db.prepare('SELECT * FROM schedules WHERE sent = 0 AND send_at <= ? ORDER BY send_at LIMIT 100').all(now);
  if (due.length === 0) return;
  for (const row of due) {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(row.subscription_id);
    if (!sub) {
      db.prepare('UPDATE schedules SET sent = 1 WHERE id = ?').run(row.id);
      continue;
    }
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    const payload = JSON.stringify({
      title: row.title,
      body: row.body || '',
      tag: row.tag || undefined
    });
    try {
      await webPush.sendNotification(subscription, payload, { TTL: 60 * 60 });
      db.prepare('UPDATE schedules SET sent = 1 WHERE id = ?').run(row.id);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        // Subscription is gone. Remove it and its schedules.
        db.prepare('DELETE FROM subscriptions WHERE id = ?').run(sub.id);
        db.prepare('DELETE FROM schedules WHERE subscription_id = ?').run(sub.id);
      } else {
        console.error('[push] error', code, err.body || err.message);
        // mark sent to avoid hot-looping; schedule will be re-pushed on next /schedule sync
        db.prepare('UPDATE schedules SET sent = 1 WHERE id = ?').run(row.id);
      }
    }
  }
}
setInterval(() => { deliverDue().catch(err => console.error('[push] deliverDue', err)); }, 30 * 1000);
setTimeout(() => { deliverDue().catch(() => {}); }, 1000);

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Lugn push server listening on :${PORT}`);
  console.log(`VAPID public key: ${vapid.publicKey}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
