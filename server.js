require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, parseTransaction } = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const rateBuckets = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { start: now, count: 0 };
    if (now - bucket.start >= windowMs) { bucket.start = now; bucket.count = 0; }
    bucket.count++;
    rateBuckets.set(key, bucket);
    if (bucket.count > limit) return res.status(429).json({ success: false, message: 'Too many requests.' });
    next();
  };
}
function normalizePhoneNumber(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/[\s\-+()]/g, '');
  if (/^0[17]\d{8}$/.test(cleaned)) return `254${cleaned.slice(1)}`;
  if (/^254[17]\d{8}$/.test(cleaned)) return cleaned;
  if (/^[17]\d{8}$/.test(cleaned)) return `254${cleaned}`;
  return null;
}
function authHeader(key) {
  const value = key.trim();
  return /^(Basic|Bearer)\s/i.test(value) ? value : `Basic ${Buffer.from(`${value}:`).toString('base64')}`;
}
function userId(phone) { return normalizePhoneNumber(phone) || 'guest'; }
function safeUser(row) {
  if (!row) return null;
  return { id: row.id, phone: row.phone, name: row.name, email: row.email, country: row.country,
    receiveMode: row.receive_mode, till: row.till, paybill: row.paybill, account: row.account,
    requirePin: Boolean(row.require_pin), useBiometrics: Boolean(row.use_biometrics),
    darkTheme: Boolean(row.dark_theme), balance: row.balance, createdAt: row.created_at, updatedAt: row.updated_at };
}
function upsertUser(input = {}) {
  const phone = normalizePhoneNumber(input.phone);
  if (!phone) throw new Error('A valid phone number is required.');
  const id = phone; const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id,phone,name,email,country,receive_mode,till,paybill,account,
    require_pin,use_biometrics,dark_theme,balance,created_at,updated_at)
    VALUES (@id,@phone,@name,@email,@country,@receiveMode,@till,@paybill,@account,@requirePin,@useBiometrics,@darkTheme,0,@now,@now)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,country=excluded.country,
    receive_mode=excluded.receive_mode,till=excluded.till,paybill=excluded.paybill,account=excluded.account,
    require_pin=excluded.require_pin,use_biometrics=excluded.use_biometrics,dark_theme=excluded.dark_theme,updated_at=excluded.updated_at`).run({
      id, phone, name: input.name || null, email: input.email || null, country: input.country || null,
      receiveMode: input.receiveMode || null, till: input.till || null, paybill: input.paybill || null,
      account: input.account || null, requirePin: input.requirePin ? 1 : 0, useBiometrics: input.useBiometrics ? 1 : 0,
      darkTheme: input.darkTheme ? 1 : 0, now
    });
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
function findTransaction(id) {
  return db.prepare('SELECT * FROM transactions WHERE tracking_id=? OR checkout_request_id=? OR reference=? LIMIT 1').get(id, id, id);
}

app.post('/api/users/sync', rateLimit(30, 60000), (req, res) => {
  try {
    const user = upsertUser(req.body.user || req.body);
    const rows = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(user.id);
    res.json({ success: true, user: safeUser(user), transactions: rows.map(parseTransaction) });
  } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.get('/api/config-check', (req, res) => {
  const key = process.env.PALPLUSS_API_KEY || '';
  const configured = Boolean(key && !key.includes('your_palpluss_api_key'));
  res.json({ configured, hasApiKey: configured, apiKeyMasked: configured ? `${key.slice(0, 7)}...${key.slice(-4)}` : null,
    channelId: process.env.PALPLUSS_CHANNEL_ID || null, hasChannel: Boolean(process.env.PALPLUSS_CHANNEL_ID),
    callbackUrl: process.env.CALLBACK_URL || null });
});
app.post('/api/stk-push', rateLimit(10, 60000), async (req, res) => {
  try {
    const { phone, amount, accountReference, transactionDesc, user } = req.body;
    const formattedPhone = normalizePhoneNumber(phone);
    const numericAmount = Number(amount);
    if (!formattedPhone) return res.status(400).json({ success: false, message: 'Invalid Kenyan phone number.' });
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 150000) return res.status(400).json({ success: false, message: 'Amount must be between 1 and 150,000 KES.' });
    const apiKey = process.env.PALPLUSS_API_KEY || '';
    if (!apiKey || apiKey.includes('your_palpluss_api_key')) return res.status(503).json({ success: false, message: 'PalPluss API is not configured.' });
    const walletUser = upsertUser({ ...(user || {}), phone: formattedPhone });
    const reference = String(accountReference || `REF${Date.now().toString().slice(-6)}`).trim().slice(0, 64);
    const description = String(transactionDesc || 'M-Pesa Payment').trim().slice(0, 128);
    const trackingId = `STK-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const payload = { phone: formattedPhone, amount: numericAmount, accountReference: reference, transactionDesc: description };
    if (process.env.PALPLUSS_CHANNEL_ID?.trim()) payload.channelId = process.env.PALPLUSS_CHANNEL_ID.trim();
    if (process.env.CALLBACK_URL?.trim()) payload.callbackUrl = process.env.CALLBACK_URL.trim();
    const response = await fetch('https://api.palpluss.com/v1/payments/stk', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader(apiKey) }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ success: false, message: data.message || data.error || 'PalPluss request failed.' });
    const now = new Date().toISOString();
    const checkout = data.checkoutRequestId || data.checkoutId || data.id || trackingId;
    db.prepare(`INSERT INTO transactions (tracking_id,user_id,phone,amount,reference,description,status,checkout_request_id,palpluss_response,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(trackingId, walletUser.id, formattedPhone, numericAmount, reference, description, 'PENDING', checkout, JSON.stringify(data), now, now);
    res.json({ success: true, message: 'STK Push prompt sent successfully to the customer phone.', trackingId, reference, phone: formattedPhone, amount: numericAmount, data });
  } catch (e) { console.error('[STK Push]', e.message); res.status(500).json({ success: false, message: 'Unable to initiate STK Push.' }); }
});
app.post('/api/callback', rateLimit(60, 60000), (req, res) => {
  try {
    const callbackSecret = process.env.CALLBACK_SECRET;
    if (callbackSecret) {
      const supplied = req.get('x-palpluss-callback-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (!supplied || supplied.length !== callbackSecret.length ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(callbackSecret))) {
        return res.status(401).json({ success: false, message: 'Unauthorized callback.' });
      }
    }
    const body = req.body || {}; const checkout = body.checkoutRequestId || body.checkoutId || body.id;
    const reference = body.accountReference || body.reference; const row = findTransaction(checkout || reference || '');
    if (!row) return res.json({ success: true, message: 'Callback received.' });
    const success = body.status === 'SUCCESS' || body.status === 'COMPLETED' || body.resultCode === 0 || body.resultCode === '0';
    const now = new Date().toISOString();
    const update = db.transaction(() => {
      db.prepare(`UPDATE transactions SET status=?,callback_data=?,receipt_number=?,result_desc=?,updated_at=? WHERE tracking_id=?`)
        .run(success ? 'SUCCESS' : 'FAILED', JSON.stringify(body), body.receiptNumber || body.mpesaReceiptNumber || body.receipt || null,
          body.resultDesc || body.message || null, now, row.tracking_id);
      if (success && !row.balance_applied) {
        db.prepare('UPDATE users SET balance=balance+?,updated_at=? WHERE id=?').run(row.amount, now, row.user_id);
        db.prepare('UPDATE transactions SET balance_applied=1 WHERE tracking_id=?').run(row.tracking_id);
      }
    });
    update(); res.json({ success: true, message: 'Callback received and processed.' });
  } catch (e) { console.error('[Callback]', e.message); res.json({ success: false, message: 'Callback received.' }); }
});
app.get('/api/status/:id', rateLimit(60, 60000), (req, res) => {
  const row = findTransaction(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'Transaction not found or expired.' });
  const user = db.prepare('SELECT balance FROM users WHERE id=?').get(row.user_id);
  res.json({ success: true, trackingId: row.tracking_id, phone: row.phone, amount: row.amount, reference: row.reference,
    status: row.status, receiptNumber: row.receipt_number, resultDesc: row.result_desc, createdAt: row.created_at, updatedAt: row.updated_at, balance: user?.balance || 0 });
});
app.get('/api/transactions', rateLimit(60, 60000), (req, res) => {
  const id = req.query.userId ? userId(req.query.userId) : null;
  const rows = id ? db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(id)
    : db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 20').all();
  res.json({ success: true, transactions: rows.map(parseTransaction) });
});
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
  }
  console.error('[HTTP]', err.message);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

if (require.main === module) app.listen(PORT, () => console.log(`PalPluss STK server listening on port ${PORT}`));
module.exports = { app, normalizePhoneNumber };
