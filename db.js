const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, 'data');
const databasePath = process.env.DATABASE_PATH || path.join(dataDir, 'lycash.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new sqlite3.Database(databasePath);

db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA foreign_keys = ON');

// Helper functions with proper error handling
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(params)) params = [params];
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(params)) params = [params];
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(params)) params = [params];
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// ============================================================
// MIGRATION: Add channel_id column
// ============================================================
function ensureChannelIdColumn() {
  return new Promise((resolve) => {
    get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").then((tableCheck) => {
      if (tableCheck) {
        get("SELECT channel_id FROM users LIMIT 1").then(() => {
          resolve();
        }).catch(() => {
          console.log('[Migration] Adding channel_id column to users table...');
          run('ALTER TABLE users ADD COLUMN channel_id TEXT').then(() => {
            console.log('[Migration] channel_id column added successfully.');
            resolve();
          }).catch(() => resolve());
        });
      } else {
        resolve();
      }
    }).catch(() => resolve());
  });
}

// ============================================================
// CREATE TABLES
// ============================================================
function createTables() {
  return new Promise((resolve, reject) => {
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
    `, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ============================================================
// LEGACY JSON MIGRATION
// ============================================================
function migrateLegacyJson() {
  return new Promise((resolve) => {
    get("SELECT 1 FROM schema_migrations WHERE version = 1").then((migration) => {
      if (migration) { resolve(); return; }
      
      const legacyPath = path.join(dataDir, 'lycash-db.json');
      let legacy;
      try { legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); } catch { legacy = null; }
      
      if (!legacy || !legacy.users || Object.keys(legacy.users).length === 0) {
        run('INSERT INTO schema_migrations VALUES (1, ?)', [new Date().toISOString()]).then(resolve);
        return;
      }
      
      const now = new Date().toISOString();
      const migrate = async () => {
        for (const user of Object.values(legacy.users || {})) {
          await run(`INSERT OR IGNORE INTO users
            (id, phone, name, email, country, receive_mode, till, paybill, account, channel_id,
             require_pin, use_biometrics, dark_theme, balance, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
            user.id,
            user.phone || user.id,
            user.name || null,
            user.email || null,
            user.country || null,
            user.receiveMode || null,
            user.till || null,
            user.paybill || null,
            user.account || null,
            user.channelId || null,
            user.requirePin ? 1 : 0,
            user.useBiometrics ? 1 : 0,
            user.darkTheme ? 1 : 0,
            Number(user.balance) || 0,
            user.createdAt || now,
            user.updatedAt || now
          ]);
        }
        for (const tx of legacy.transactions || []) {
          await run(`INSERT OR IGNORE INTO transactions
            (tracking_id,user_id,phone,amount,reference,description,status,checkout_request_id,
             palpluss_response,callback_data,receipt_number,result_desc,balance_applied,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
            tx.trackingId,
            tx.userId,
            tx.phone,
            Number(tx.amount) || 0,
            tx.reference || null,
            tx.description || null,
            tx.status || 'PENDING',
            tx.checkoutRequestId || null,
            JSON.stringify(tx.palplussResponse || null),
            JSON.stringify(tx.callbackData || null),
            tx.receiptNumber || null,
            tx.resultDesc || null,
            tx.balanceApplied ? 1 : 0,
            tx.createdAt || now,
            tx.updatedAt || now
          ]);
        }
        await run('INSERT INTO schema_migrations VALUES (1, ?)', [now]);
      };
      migrate().then(resolve).catch(() => resolve());
    }).catch(() => resolve());
  });
}

// ============================================================
// WRAPPER FUNCTIONS (better-sqlite3 style)
// ============================================================
function prepare(sql) {
  // Get all params from the statement
  const paramCount = (sql.match(/\?/g) || []).length;
  
  return {
    get: function(...args) {
      let params = args;
      if (args.length === 1 && Array.isArray(args[0])) params = args[0];
      if (params.length < paramCount) {
        // Pad with null for missing params
        while (params.length < paramCount) params.push(null);
      }
      return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    },
    all: function(...args) {
      let params = args;
      if (args.length === 1 && Array.isArray(args[0])) params = args[0];
      if (params.length < paramCount) {
        while (params.length < paramCount) params.push(null);
      }
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
    },
    run: function(...args) {
      let params = args;
      if (args.length === 1 && Array.isArray(args[0])) params = args[0];
      if (params.length < paramCount) {
        while (params.length < paramCount) params.push(null);
      }
      return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes, lastID: this.lastID });
        });
      });
    }
  };
}

function transaction(fn) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) { reject(err); return; }
        try {
          const result = fn(...args);
          db.run('COMMIT', (err2) => {
            if (err2) {
              db.run('ROLLBACK');
              reject(err2);
            } else {
              resolve(result);
            }
          });
        } catch (e) {
          db.run('ROLLBACK');
          reject(e);
        }
      });
    });
  };
}

function parseTransaction(row) {
  if (!row) return row;
  try {
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
  } catch {
    return row;
  }
}

// Initialize
async function initDb() {
  try {
    await ensureChannelIdColumn();
    await createTables();
    await migrateLegacyJson();
    console.log('[Database] Initialized successfully.');
  } catch (err) {
    console.error('[Database] Error:', err);
  }
}

initDb();

module.exports = { 
  db, 
  parseTransaction,
  get,
  all,
  run,
  prepare,
  transaction
};