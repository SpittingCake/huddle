-- Huddle schema, batch 0: users, sessions, the one server, channels, invites.
-- Messages / reactions / pins / etc. arrive in batch 3; games in batch 6.

CREATE TABLE users (
  id                serial PRIMARY KEY,
  username          text NOT NULL UNIQUE,
  password_hash     text NOT NULL,
  display_name      text NOT NULL,
  avatar_url        text,
  role              text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status            text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'idle', 'dnd', 'invisible')),
  custom_status     text,
  activity_sharing  boolean NOT NULL DEFAULT true,
  token_version     integer NOT NULL DEFAULT 1,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per signed-in device. Sign out deletes the row; a password change
-- or ban bumps users.token_version, which invalidates every row at once.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Exactly one server (the friend group). Enforced by the CHECK on id.
CREATE TABLE server (
  id          integer PRIMARY KEY CHECK (id = 1),
  name        text NOT NULL,
  icon_url    text,
  owner_id    integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  id          serial PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('text', 'voice')),
  name        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  code        text PRIMARY KEY,
  created_by  integer NOT NULL REFERENCES users(id),
  expires_at  timestamptz,
  max_uses    integer,
  uses        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
