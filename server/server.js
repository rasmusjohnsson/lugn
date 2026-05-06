// Lugn — Web Push backend
// Receives push subscriptions from the PWA, stores scheduled notifications,
// and delivers them via Web Push when the time comes.
//
// Storage: in-memory by default. If LUGN_DATA_DIR is set, the store is
// persisted to JSON on disk between writes (useful with a persistent volume).
// VAPID keys come from env vars when set, otherwise generated and logged.

'use strict';

const express = require('express');
const cors = require('cors');
const webPush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3030);
const DATA_DIR = process.env.LUGN_DATA_DIR || '';
const VAPID_SUBJECT = process.env.LUGN_VAPID_SUBJECT || 'mailto:lugn@example.com';
const ALLOWED_ORIGINS = (process.env.LUGN_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const STORE_FILE = DATA_DIR ? path.join(DATA_DIR, 'store.json') : '';
if (DATA_DIR) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// ---------- VAPID keys (env > file > generate) ----------
const VAPID_FILE = DATA_DIR ? path.join(DATA_DIR, 'vapid.json') : '';
let vapid;
if (process.env.LUGN_VAPID_PUBLIC_KEY && process.env.LUGN_VAPID_PRIVATE_KEY) {
  vapid = {
    publicKey: process.env.LUGN_VAPID_PUBLIC_KEY,
    privateKey: process.env.LUGN_VAPID_PRIVATE_KEY
  };
  console.log('Using VAPID keys from environment.');
} else if (VAPID_FILE && fs.existsSync(VAPID_FILE)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapid = webPush.generateVAPIDKeys();
  if (VAPID_FILE) {
    try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2)); } catch {}
  }
  console.log('Generated new VAPID keys.');
  console.log('IMPORTANT — copy these to LUGN_VAPID_PUBLIC_KEY and LUGN_VAPID_PRIVATE_KEY');
  console.log('environment variables to keep them stable across redeploys:');
  console.log(JSON.stringify(vapid, null, 2));
}
webPush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

// ---------- Storage (in-memory; optionally persisted to JSON) ----------
const subscriptions = new Map();      // id -> sub
const endpointToId = new Map();        // endpoint -> id
let schedules = [];                    // [{ id, subscriptionId, tag, title, body, sendAt, sent }]
let scheduleIdSeq = 1;

function persist() {
  if (!STORE_FILE) return;
  const data = {
    subscriptions: Array.from(subscriptions.values()),
    schedules,
    scheduleIdSeq
  };
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(data)); }
  catch (e) { console.error('persist', e.message); }
}
function loadIfExists() {
  if (!STORE_FILE || !fs.existsSync(STORE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const s of (data.subscriptions || [])) {
      subscriptions.set(s.id, s);
      endpointToId.set(s.endpoint, s.id);
    }
    schedules = Array.isArray(data.schedules) ? data.schedules : [];
    if (typeof data.scheduleIdSeq === 'number') scheduleIdSeq = data.scheduleIdSeq;
    console.log(`Loaded ${subscriptions.size} subscriptions, ${schedules.length} schedules`);
  } catch (e) { console.error('load', e.message); }
}
loadIfExists();

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed: ' + origin));
  }
}));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/vapid-public-key', (req, res) => res.json({ key: vapid.publicKey }));

// Subscribe (idempotent by endpoint)
app.post('/subscribe', (req, res) => {
  const sub = req.body && req.body.subscription;
  const ua = (req.body && req.body.userAgent) || req.headers['user-agent'] || '';
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  const now = Date.now();
  const existingId = endpointToId.get(sub.endpoint);
  if (existingId) {
    const existing = subscriptions.get(existingId);
    existing.p256dh = sub.keys.p256dh;
    existing.auth = sub.keys.auth;
    existing.userAgent = ua.slice(0, 200);
    existing.lastSeenAt = now;
    persist();
    return res.json({ subscriptionId: existingId });
  }
  const id = crypto.randomUUID();
  const newSub = {
    id,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    userAgent: ua.slice(0, 200),
    createdAt: now,
    lastSeenAt: now
  };
  subscriptions.set(id, newSub);
  endpointToId.set(sub.endpoint, id);
  persist();
  res.json({ subscriptionId: id });
});

// Replace all upcoming scheduled notifications for a subscription
app.post('/schedule', (req, res) => {
  const { subscriptionId, items } = req.body || {};
  if (!subscriptionId || !Array.isArray(items)) {
    return res.status(400).json({ error: 'expected { subscriptionId, items: [] }' });
  }
  const sub = subscriptions.get(subscriptionId);
  if (!sub) return res.status(404).json({ error: 'subscription not found' });

  // Remove all unsent schedules for this subscription
  schedules = schedules.filter(s => !(s.subscriptionId === subscriptionId && !s.sent));

  const minSendAt = Date.now() - 5 * 60_000;
  for (const it of items) {
    if (!it || !it.title || !it.sendAt) continue;
    const sendAt = Number(it.sendAt);
    if (!Number.isFinite(sendAt) || sendAt < minSendAt) continue;
    schedules.push({
      id: scheduleIdSeq++,
      subscriptionId,
      tag: (it.tag || '').slice(0, 120) || null,
      title: String(it.title).slice(0, 120),
      body: (it.body ? String(it.body) : '').slice(0, 240),
      sendAt,
      sent: false
    });
  }
  sub.lastSeenAt = Date.now();
  persist();
  const count = schedules.filter(s => s.subscriptionId === subscriptionId && !s.sent).length;
  res.json({ ok: true, scheduled: count });
});

// Remove a subscription and all its schedules
app.delete('/subscribe/:subscriptionId', (req, res) => {
  const id = req.params.subscriptionId;
  const sub = subscriptions.get(id);
  if (sub) endpointToId.delete(sub.endpoint);
  subscriptions.delete(id);
  schedules = schedules.filter(s => s.subscriptionId !== id);
  persist();
  res.json({ ok: true });
});

// ---------- Scheduler ----------
async function deliverDue() {
  const now = Date.now();
  const due = schedules.filter(s => !s.sent && s.sendAt <= now).slice(0, 100);
  if (due.length === 0) return;
  let changed = false;
  for (const row of due) {
    const sub = subscriptions.get(row.subscriptionId);
    if (!sub) { row.sent = true; changed = true; continue; }
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
      row.sent = true;
      changed = true;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        endpointToId.delete(sub.endpoint);
        subscriptions.delete(sub.id);
        schedules = schedules.filter(s => s.subscriptionId !== sub.id);
        changed = true;
      } else {
        console.error('[push] error', code, err.body || err.message);
        row.sent = true;
        changed = true;
      }
    }
  }
  if (changed) persist();
}
setInterval(() => { deliverDue().catch(err => console.error('[push] deliverDue', err)); }, 30 * 1000);
setTimeout(() => { deliverDue().catch(() => {}); }, 1000);

// Periodically prune sent schedules
setInterval(() => {
  const before = schedules.length;
  schedules = schedules.filter(s => !s.sent || s.sendAt > Date.now() - 24 * 60 * 60_000);
  if (schedules.length !== before) persist();
}, 60 * 60 * 1000);

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Lugn push server listening on :${PORT}`);
  console.log(`Storage: ${STORE_FILE ? 'persistent (' + STORE_FILE + ')' : 'in-memory only'}`);
  console.log(`VAPID public key: ${vapid.publicKey}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
