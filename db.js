const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
const databasePath = process.env.DATABASE_PATH || path.join(dataDir, 'lycash.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    email TEXT,
    country TEXT,
    receive_mode TEXT,
    till TEXT,
    paybill TEXT,
    account TEXT,
    channel_id TEXT,
    require_pin INTEGER NOT NULL DEFAULT 0,
    use_biometrics INTEGER NOT NULL DEFAULT 0,
    dark_theme INTEGER NOT NULL DEFAULT 0,
    balance REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS transactions (
    tracking_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    reference TEXT,
    description TEXT,
    status TEXT NOT NULL,
    checkout_request_id TEXT,
    palpluss_response TEXT,
    callback_data TEXT,
    receipt_number TEXT,
    result_desc TEXT,
    balance_applied INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_transactions_user_created
    ON transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_checkout
    ON transactions(checkout_request_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_reference
    ON transactions(reference);
  CREATE INDEX IF NOT EXISTS idx_users_channel
    ON users(channel_id);
`);

// ============================================================
// MIGRATION: Add channel_id column if it doesn't exist
// ============================================================
function ensureChannelIdColumn() {
  try {
    // Check if column exists by trying to select it
    db.prepare('SELECT channel_id FROM users LIMIT 1').get();
  } catch (e) {
    // Column doesn't exist, add it
    console.log('[Migration] Adding channel_id column to users table...');
    db.exec('ALTER TABLE users ADD COLUMN channel_id TEXT');
    console.log('[Migration] channel_id column added successfully.');
  }
}
ensureChannelIdColumn();

function migrateLegacyJson() {
  const migration = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get();
  if (migration) return;
  
  const legacyPath = path.join(dataDir, 'lycash-db.json');
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); } catch { legacy = null; }
  
  const now = new Date().toISOString();
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, phone, name, email, country, receive_mode, till, paybill, account, channel_id,
       require_pin, use_biometrics, dark_theme, balance, created_at, updated_at)
    VALUES (@id,@phone,@name,@email,@country,@receiveMode,@till,@paybill,@account,@channelId,
      @requirePin,@useBiometrics,@darkTheme,@balance,@createdAt,@updatedAt)
  `);
  const insertTx = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (tracking_id,user_id,phone,amount,reference,description,status,checkout_request_id,
       palpluss_response,callback_data,receipt_number,result_desc,balance_applied,created_at,updated_at)
    VALUES (@trackingId,@userId,@phone,@amount,@reference,@description,@status,@checkoutRequestId,
      @palplussResponse,@callbackData,@receiptNumber,@resultDesc,@balanceApplied,@createdAt,@updatedAt)
  `);
  
  const migrate = db.transaction(() => {
    for (const user of Object.values(legacy?.users || {})) {
      insertUser.run({
        id: user.id,
        phone: user.phone || user.id,
        name: user.name || null,
        email: user.email || null,
        country: user.country || null,
        receiveMode: user.receiveMode || null,
        till: user.till || null,
        paybill: user.paybill || null,
        account: user.account || null,
        channelId: user.channelId || null,
        requirePin: user.requirePin ? 1 : 0,
        useBiometrics: user.useBiometrics ? 1 : 0,
        darkTheme: user.darkTheme ? 1 : 0,
        balance: Number(user.balance) || 0,
        createdAt: user.createdAt || now,
        updatedAt: user.updatedAt || now
      });
    }
    for (const tx of legacy?.transactions || []) {
      insertTx.run({
        trackingId: tx.trackingId,
        userId: tx.userId,
        phone: tx.phone,
        amount: Number(tx.amount) || 0,
        reference: tx.reference || null,
        description: tx.description || null,
        status: tx.status || 'PENDING',
        checkoutRequestId: tx.checkoutRequestId || null,
        palplussResponse: JSON.stringify(tx.palplussResponse || null),
        callbackData: JSON.stringify(tx.callbackData || null),
        receiptNumber: tx.receiptNumber || null,
        resultDesc: tx.resultDesc || null,
        balanceApplied: tx.balanceApplied ? 1 : 0,
        createdAt: tx.createdAt || now,
        updatedAt: tx.updatedAt || now
      });
    }
    db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(now);
  });
  migrate();
}
migrateLegacyJson();

function parseTransaction(row) {
  if (!row) return row;
  return {
    trackingId: row.tracking_id,
    userId: row.user_id,
    phone: row.phone,
    amount: row.amount,
    reference: row.reference,
    description: row.description,
    status: row.status,
    checkoutRequestId: row.checkout_request_id,
    palplussResponse: JSON.parse(row.palpluss_response || 'null'),
    callbackData: JSON.parse(row.callback_data || 'null'),
    receiptNumber: row.receipt_number,
    resultDesc: row.result_desc,
    balanceApplied: Boolean(row.balance_applied),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = { db, parseTransaction };