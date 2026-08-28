require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, parseTransaction } = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const rateBuckets = new Map();

app.set('trust proxy', 1);

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

// ============================================================
// HELPERS
// ============================================================

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_APP_URL) {
    return process.env.PUBLIC_APP_URL.replace(/\/+$/, '');
  }
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  let host = req.get('x-forwarded-host') || req.get('host');
  if (process.env.RENDER_SERVICE_HOST) host = process.env.RENDER_SERVICE_HOST;
  if (process.env.VERCEL_URL) host = process.env.VERCEL_URL;
  if (process.env.HEROKU_APP_NAME) host = `${process.env.HEROKU_APP_NAME}.herokuapp.com`;
  if (!host) host = req.get('host') || 'localhost:3000';
  const finalProtocol = protocol === 'http' ? 'http' : 'https';
  return `${finalProtocol}://${host}`;
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
  return {
    id: row.id, phone: row.phone, name: row.name, email: row.email, country: row.country,
    receiveMode: row.receive_mode, till: row.till, paybill: row.paybill, account: row.account,
    channelId: row.channel_id,
    requirePin: Boolean(row.require_pin), useBiometrics: Boolean(row.use_biometrics),
    darkTheme: Boolean(row.dark_theme), balance: row.balance, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function upsertUser(input = {}) {
  const phone = normalizePhoneNumber(input.phone);
  if (!phone) throw new Error('A valid phone number is required.');
  const id = phone;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id,phone,name,email,country,receive_mode,till,paybill,account,channel_id,
    require_pin,use_biometrics,dark_theme,balance,created_at,updated_at)
    VALUES (@id,@phone,@name,@email,@country,@receiveMode,@till,@paybill,@account,@channelId,
    @requirePin,@useBiometrics,@darkTheme,0,@now,@now)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,country=excluded.country,
    receive_mode=excluded.receive_mode,till=excluded.till,paybill=excluded.paybill,account=excluded.account,
    channel_id=COALESCE(excluded.channel_id, channel_id),
    require_pin=excluded.require_pin,use_biometrics=excluded.use_biometrics,dark_theme=excluded.dark_theme,updated_at=excluded.updated_at`).run({
    id, phone, name: input.name || null, email: input.email || null, country: input.country || null,
    receiveMode: input.receiveMode || null, till: input.till || null, paybill: input.paybill || null,
    account: input.account || null, channelId: input.channelId || null,
    requirePin: input.requirePin ? 1 : 0, useBiometrics: input.useBiometrics ? 1 : 0,
    darkTheme: input.darkTheme ? 1 : 0, now
  });
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

function findTransaction(id) {
  return db.prepare('SELECT * FROM transactions WHERE tracking_id=? OR checkout_request_id=? OR reference=? LIMIT 1').get(id, id, id);
}

function normalizePaymentStatus(input) {
  const status = String(input || '').toUpperCase().trim();
  const successStatuses = ['SUCCESS', 'COMPLETED', 'SUCCESSFUL'];
  const failedStatuses = ['FAILED', 'FAILURE', 'REJECTED', 'CANCELLED'];
  const pendingStatuses = ['PENDING', 'PROCESSING', 'INITIATED'];
  if (successStatuses.includes(status)) return 'SUCCESS';
  if (failedStatuses.includes(status)) return 'FAILED';
  if (pendingStatuses.includes(status)) return 'PENDING';
  return 'UNKNOWN';
}

function extractCallbackData(body) {
  const data = body.data || body.result || body.transaction || body.payload || body;
  const result = {};
  const fields = {
    trackingId: ['trackingId', 'tracking_id', 'merchantReference', 'reference'],
    checkoutRequestId: ['checkoutRequestId', 'checkout_request_id', 'checkoutId', 'checkout_id'],
    reference: ['reference', 'accountReference', 'account_reference'],
    amount: ['amount', 'Amount', 'transactionAmount'],
    status: ['status', 'Status', 'resultCode', 'result_code'],
    resultDesc: ['resultDesc', 'result_desc', 'message', 'description'],
    receiptNumber: ['receiptNumber', 'receipt_number', 'mpesaReceiptNumber', 'mpesa_receipt_number'],
    transactionId: ['transactionId', 'transaction_id', 'id']
  };
  for (const [key, aliases] of Object.entries(fields)) {
    for (const alias of aliases) {
      if (data[alias] !== undefined && data[alias] !== null) {
        result[key] = data[alias];
        break;
      }
    }
  }
  if (result.status !== undefined && !isNaN(result.status)) {
    const code = Number(result.status);
    if (code === 0) result.status = 'SUCCESS';
    else if (code >= 1 && code <= 99) result.status = 'FAILED';
    else result.status = 'UNKNOWN';
  }
  return result;
}

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

// ============================================================
// ROUTES
// ============================================================

app.post('/api/users/sync', rateLimit(30, 60000), (req, res) => {
  try {
    const user = upsertUser(req.body.user || req.body);
    const rows = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(user.id);
    res.json({ success: true, user: safeUser(user), transactions: rows.map(parseTransaction) });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Update user profile - resets channel_id when shortcode changes
app.post('/api/users/update', rateLimit(10, 60000), (req, res) => {
  try {
    const { phone, receiveMode, till, paybill, account } = req.body;
    const formattedPhone = normalizePhoneNumber(phone);
    if (!formattedPhone) {
      return res.status(400).json({ success: false, message: 'Invalid phone number.' });
    }

    const now = new Date().toISOString();
    
    // RESET channel_id when shortcode changes so new one is fetched from PalPluss
    const result = db.prepare(`UPDATE users SET 
      receive_mode = COALESCE(?, receive_mode),
      till = ?,
      paybill = ?,
      account = ?,
      channel_id = NULL,
      updated_at = ?
      WHERE id = ?`).run(
      receiveMode || null,
      till || null,
      paybill || null,
      account || null,
      now,
      formattedPhone
    );

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(formattedPhone);
    console.log('[Update Profile] Channel ID reset for user:', formattedPhone);
    
    res.json({ 
      success: true, 
      message: 'Profile updated. Channel ID reset for new shortcode.',
      user: safeUser(user) 
    });

  } catch (e) {
    console.error('[Update Profile] Error:', e.message);
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
});

app.get('/api/config-check', (req, res) => {
  const key = process.env.PALPLUSS_API_KEY || '';
  const configured = Boolean(key && !key.includes('your_palpluss_api_key'));
  const baseUrl = getPublicBaseUrl(req);
  res.json({
    configured,
    hasApiKey: configured,
    apiKeyMasked: configured ? `${key.slice(0, 7)}...${key.slice(-4)}` : null,
    publicBaseUrl: baseUrl,
    dynamicCallbackUrl: `${baseUrl}/api/callback`
  });
});

app.post('/api/stk-push', rateLimit(10, 60000), async (req, res) => {
  try {
    const { phone, amount, accountReference, transactionDesc, user } = req.body;
    const formattedPhone = normalizePhoneNumber(phone);
    const numericAmount = Number(amount);

    if (!formattedPhone) return res.status(400).json({ success: false, message: 'Invalid Kenyan phone number.' });
    if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 150000) {
      return res.status(400).json({ success: false, message: 'Amount must be between 1 and 150,000 KES.' });
    }

    const apiKey = process.env.PALPLUSS_API_KEY || '';
    if (!apiKey || apiKey.includes('your_palpluss_api_key')) {
      return res.status(503).json({ success: false, message: 'PalPluss API is not configured.' });
    }

    const walletUser = upsertUser({ ...(user || {}), phone: formattedPhone });

    // Get user's channel ID - will be NULL if shortcode was updated
    const userRow = db.prepare('SELECT channel_id, receive_mode, till, paybill, account FROM users WHERE id=?').get(walletUser.id);
    let userChannelId = userRow?.channel_id || null;

    const reference = String(accountReference || `REF${Date.now().toString().slice(-6)}`).trim().slice(0, 64);
    const description = String(transactionDesc || 'M-Pesa Payment').trim().slice(0, 128);
    const trackingId = `STK-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const payload = {
      phone: formattedPhone,
      amount: numericAmount,
      accountReference: reference,
      transactionDesc: description
    };

    // If channel ID exists, use it. If NULL, PalPluss will register new shortcode
    if (userChannelId) {
      payload.channelId = userChannelId;
      console.log('[STK] Using existing channel ID:', userChannelId);
    } else {
      console.log('[STK] No channel ID - PalPluss will register new shortcode');
    }

    // DYNAMIC CALLBACK URL
    const callbackUrl = `${getPublicBaseUrl(req)}/api/callback`;
    payload.callbackUrl = callbackUrl;

    console.log('[STK] Callback URL:', callbackUrl);

    const response = await fetch('https://api.palpluss.com/v1/payments/stk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(apiKey)
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('[STK] PalPluss error:', data);
      return res.status(502).json({ success: false, message: data.message || data.error || 'PalPluss request failed.' });
    }

    // If PalPluss returns a channel ID, save it to the user
    const responseChannelId = data.channelId || data.channel_id || data.channelID;
    if (responseChannelId) {
      console.log('[STK] Saving channel ID from response:', responseChannelId);
      db.prepare('UPDATE users SET channel_id = ? WHERE id = ?').run(responseChannelId, walletUser.id);
    }

    const now = new Date().toISOString();
    const checkout = data.checkoutRequestId || data.checkoutId || data.id || trackingId;

    db.prepare(`INSERT INTO transactions (tracking_id,user_id,phone,amount,reference,description,status,checkout_request_id,palpluss_response,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(trackingId, walletUser.id, formattedPhone, numericAmount, reference, description, 'PENDING', checkout, JSON.stringify(data), now, now);

    console.log('[STK] Created trackingId:', trackingId);

    res.json({
      success: true,
      message: 'STK Push prompt sent successfully to the customer phone.',
      trackingId,
      reference,
      phone: formattedPhone,
      amount: numericAmount,
      callbackUrl,
      channelId: userChannelId || null,
      data
    });

  } catch (e) {
    console.error('[STK] Error:', e.message);
    res.status(500).json({ success: false, message: 'Unable to initiate STK Push.' });
  }
});

app.post('/api/callback', rateLimit(60, 60000), (req, res) => {
  const callbackStart = Date.now();
  try {
    console.log('[CALLBACK] Received at:', new Date().toISOString());

    const callbackSecret = process.env.CALLBACK_SECRET;
    if (callbackSecret) {
      const supplied = req.get('x-palpluss-callback-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (!supplied || supplied.length !== callbackSecret.length ||
          !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(callbackSecret))) {
        console.warn('[CALLBACK] Unauthorized callback attempt');
        return res.status(401).json({ success: false, message: 'Unauthorized callback.' });
      }
    }

    const body = req.body || {};
    const extracted = extractCallbackData(body);

    console.log('[CALLBACK] Extracted:', {
      trackingId: extracted.trackingId,
      checkoutRequestId: extracted.checkoutRequestId,
      reference: extracted.reference,
      status: extracted.status,
      amount: extracted.amount,
      resultDesc: extracted.resultDesc,
      receiptNumber: extracted.receiptNumber
    });

    let row = null;
    if (extracted.trackingId) row = findTransaction(extracted.trackingId);
    if (!row && extracted.checkoutRequestId) row = findTransaction(extracted.checkoutRequestId);
    if (!row && extracted.reference) row = findTransaction(extracted.reference);
    if (!row && extracted.transactionId) row = findTransaction(extracted.transactionId);

    if (!row) {
      console.log('[CALLBACK] No matching transaction found for:', extracted);
      return res.json({ success: true, message: 'Callback received, but no matching transaction.' });
    }

    console.log('[CALLBACK] Found transaction:', row.tracking_id, 'current status:', row.status);

    // If PalPluss returns a channel ID in the callback, save it
    const callbackChannelId = body.channelId || body.channel_id || body.channelID;
    if (callbackChannelId && row.user_id) {
      const user = db.prepare('SELECT channel_id FROM users WHERE id=?').get(row.user_id);
      if (!user?.channel_id) {
        console.log('[CALLBACK] Saving channel ID from callback:', callbackChannelId);
        db.prepare('UPDATE users SET channel_id = ? WHERE id = ?').run(callbackChannelId, row.user_id);
      }
    }

    const incomingStatus = normalizePaymentStatus(extracted.status);
    console.log('[CALLBACK] Normalized status:', incomingStatus);

    if (row.status === 'SUCCESS') {
      console.log('[CALLBACK] Transaction already SUCCESS, skipping.');
      return res.json({ success: true, message: 'Transaction already processed.' });
    }

    const now = new Date().toISOString();

    const update = db.transaction(() => {
      db.prepare(`UPDATE transactions SET 
        status=?,
        callback_data=?,
        receipt_number=?,
        result_desc=?,
        updated_at=?
        WHERE tracking_id=?`)
        .run(
          incomingStatus === 'SUCCESS' ? 'SUCCESS' :
          incomingStatus === 'FAILED' ? 'FAILED' : 'PENDING',
          JSON.stringify(body),
          extracted.receiptNumber || body.receiptNumber || body.mpesaReceiptNumber || null,
          extracted.resultDesc || body.resultDesc || body.message || null,
          now,
          row.tracking_id
        );

      if (incomingStatus === 'SUCCESS' && !row.balance_applied) {
        console.log('[CALLBACK] Crediting wallet:', row.amount, 'for user:', row.user_id);
        db.prepare('UPDATE users SET balance=balance+?,updated_at=? WHERE id=?')
          .run(row.amount, now, row.user_id);
        db.prepare('UPDATE transactions SET balance_applied=1 WHERE tracking_id=?')
          .run(row.tracking_id);
        console.log('[CALLBACK] Wallet credited successfully.');
      } else if (incomingStatus === 'SUCCESS' && row.balance_applied) {
        console.log('[CALLBACK] Balance already applied, skipping credit.');
      }
    });

    update();

    console.log('[CALLBACK] Processed in:', Date.now() - callbackStart, 'ms');

    res.json({
      success: true,
      message: 'Callback received and processed.',
      status: incomingStatus,
      trackingId: row.tracking_id
    });

  } catch (e) {
    console.error('[CALLBACK] Error:', e.message);
    console.error('[CALLBACK] Stack:', e.stack);
    res.json({ success: false, message: 'Callback received but processing failed.' });
  }
});

app.get('/api/status/:id', rateLimit(60, 60000), (req, res) => {
  const row = findTransaction(req.params.id);
  if (!row) {
    return res.status(404).json({ success: false, message: 'Transaction not found.' });
  }
  const user = db.prepare('SELECT balance FROM users WHERE id=?').get(row.user_id);
  res.json({
    success: true,
    trackingId: row.tracking_id,
    phone: row.phone,
    amount: row.amount,
    reference: row.reference,
    status: row.status,
    receiptNumber: row.receipt_number,
    resultDesc: row.result_desc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    balance: user?.balance || 0
  });
});

app.get('/api/transactions', rateLimit(60, 60000), (req, res) => {
  const id = req.query.userId ? userId(req.query.userId) : null;
  const rows = id
    ? db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(id)
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`LyCash server listening on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Database path: ${process.env.DATABASE_PATH || './data/lycash.db'}`);
    if (process.env.RENDER_SERVICE_HOST) {
      console.log(`Render host: ${process.env.RENDER_SERVICE_HOST}`);
    }
  });
}

module.exports = { app, normalizePhoneNumber, getPublicBaseUrl };