-- Batch 3: text channels. Messages, attachments (also used for avatars and
-- the server icon), reactions, pins, per-user read markers, and the mention
-- table that makes unread/mention badges one cheap query.

CREATE TABLE messages (
  id           serial PRIMARY KEY,
  channel_id   integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id    integer NOT NULL REFERENCES users(id),
  body         text NOT NULL DEFAULT '',
  reply_to_id  integer REFERENCES messages(id) ON DELETE SET NULL,
  edited_at    timestamptz,
  deleted_at   timestamptz,           -- soft delete: keeps reply targets honest
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_channel_idx ON messages(channel_id, id);

-- One row per uploaded file. kind = 'message' rows hang off a message
-- (message_id is NULL until the message is posted; orphans older than an hour
-- are swept). 'avatar' / 'icon' rows are profile pictures / the server icon.
CREATE TABLE attachments (
  id           serial PRIMARY KEY,
  message_id   integer REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id  integer NOT NULL REFERENCES users(id),
  kind         text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'avatar', 'icon')),
  filename     text NOT NULL,
  mime         text NOT NULL,
  size         integer NOT NULL,
  storage_key  text NOT NULL UNIQUE,  -- random name on disk; also the public URL (/files/<key>)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_idx ON attachments(message_id);

CREATE TABLE reactions (
  message_id   integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE pins (
  message_id   integer PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  channel_id   integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  pinned_by    integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pins_channel_idx ON pins(channel_id);

CREATE TABLE read_markers (
  user_id               integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id            integer NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- Who a message @mentions (parsed server-side on create/edit). @everyone
-- expands to every active member except the author.
CREATE TABLE message_mentions (
  message_id   integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user_idx ON message_mentions(user_id);
