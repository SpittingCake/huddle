// First boot: create the owner account and the server row if the users table
// is empty. Runs on every start but does nothing once a user exists.

const bcrypt = require('bcryptjs');
const db = require('./db');

async function bootstrap() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  const username = process.env.OWNER_USERNAME;
  const password = process.env.OWNER_PASSWORD;
  if (!username || !password) {
    console.warn('[bootstrap] users table is empty and OWNER_USERNAME / OWNER_PASSWORD are not set — nobody can sign in yet.');
    return;
  }
  if (password.length < 10) {
    console.error('[bootstrap] OWNER_PASSWORD must be at least 10 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const owner = (
    await db.query(
      `INSERT INTO users (username, password_hash, display_name, role)
       VALUES ($1, $2, $3, 'owner') RETURNING id`,
      [username, hash, process.env.OWNER_DISPLAY_NAME || username]
    )
  ).rows[0];

  await db.query(
    `INSERT INTO server (id, name, owner_id) VALUES (1, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [process.env.SERVER_NAME || 'Huddle', owner.id]
  );
  await db.query(
    `INSERT INTO channels (type, name, position) VALUES
       ('text', 'general', 0),
       ('voice', 'Lobby', 1)`
  );
  console.log(`[bootstrap] created owner "${username}" and server "${process.env.SERVER_NAME || 'Huddle'}" with #general + Lobby`);
}

module.exports = { bootstrap };
