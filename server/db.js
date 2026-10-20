// Postgres pool + tiny migration runner.
// Migrations live in server/migrations/NNN_name.sql and run once, in order.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See server/.env.example');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres doesn't need SSL; public URLs do.
  ssl: /railway\.app|rlwy\.net/.test(process.env.DATABASE_URL) && !/\.railway\.internal/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => console.error('[db] idle client error', err));

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[db] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[db] migration ${file} failed:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, query: (text, params) => pool.query(text, params), migrate };
