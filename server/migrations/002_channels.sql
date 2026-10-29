-- Batch 2: channel categories (collapsible headers in the rail) and a
-- category pointer on channels. Uncategorized channels sit above the first
-- category. Deleting a category leaves its channels in place (uncategorized).

CREATE TABLE categories (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE channels
  ADD COLUMN category_id integer REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX channels_category_idx ON channels(category_id);
