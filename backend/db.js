// db.js — PostgreSQL connection pool
// Uses a single connection string from the DATABASE_URL environment variable,
// which Railway provides automatically in production.

const { Pool } = require('pg')
require('dotenv').config()

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is not set. Check your .env file.',
  )
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres uses SSL in production; disable cert verification for
  // managed cloud instances while keeping encryption enabled.
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
})

// Test the connection on startup so misconfiguration surfaces immediately.
pool.connect((err, client, release) => {
  if (err) {
    console.error('[DB] Failed to connect to PostgreSQL:', err.message)
    return
  }
  release()
  console.log('[DB] PostgreSQL connected successfully.')
})

// ----------------------------------------------------------------
// Schema initialisation — runs once when the server starts.
// Creates the required tables if they do not already exist.
// ----------------------------------------------------------------
const initSchema = async () => {
  const createUsers = `
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         VARCHAR(255) UNIQUE NOT NULL,
      credits_remaining INTEGER NOT NULL DEFAULT 5,
      last_ip       VARCHAR(45),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `

  const createNoticeLogs = `
    CREATE TABLE IF NOT EXISTS notice_logs (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notice_type      VARCHAR(100),
      demand_amount    NUMERIC(15, 2),
      section_invoked  VARCHAR(200),
      draft_text       TEXT,
      timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `

  // Migrate existing notice_logs table if columns are missing
  const migrateNoticeLogs = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='notice_logs' AND column_name='section_invoked') THEN
        ALTER TABLE notice_logs ADD COLUMN section_invoked VARCHAR(200);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='notice_logs' AND column_name='draft_text') THEN
        ALTER TABLE notice_logs ADD COLUMN draft_text TEXT;
      END IF;
    END$$;
  `

  const createPurchases = `
    CREATE TABLE IF NOT EXISTS purchases (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      razorpay_order_id     VARCHAR(100) UNIQUE NOT NULL,
      razorpay_payment_id   VARCHAR(100),
      credits_added         INTEGER NOT NULL,
      amount_paise          INTEGER NOT NULL,
      pack_label            VARCHAR(50),
      status                VARCHAR(20) NOT NULL DEFAULT 'created',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `

  try {
    await pool.query(createUsers)
    await pool.query(createNoticeLogs)
    await pool.query(migrateNoticeLogs)
    await pool.query(createPurchases)
    console.log('[DB] Schema verified / tables ready.')
  } catch (err) {
    console.error('[DB] Schema initialisation failed:', err.message)
    throw err
  }
}

module.exports = { pool, initSchema }
