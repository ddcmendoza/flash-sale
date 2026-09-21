-- Flash sale schema. Applied idempotently by `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS sales (
  id             TEXT        PRIMARY KEY,
  name           TEXT        NOT NULL,
  price_cents    INTEGER     NOT NULL CHECK (price_cents > 0),
  total_quantity INTEGER     NOT NULL CHECK (total_quantity >= 0),
  sold_count     INTEGER     NOT NULL DEFAULT 0
                 CHECK (sold_count >= 0),
  start_at       TIMESTAMPTZ NOT NULL,
  end_at         TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_window_valid CHECK (end_at > start_at),
  CONSTRAINT sales_sold_within CHECK (sold_count <= total_quantity)
);

-- Hard stop for "one item per user": a second INSERT for the same
-- (sale_id, user_id) fails at the constraint level, even under a race.
CREATE TABLE IF NOT EXISTS purchases (
  id         BIGSERIAL   PRIMARY KEY,
  sale_id    TEXT        NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL CHECK (length(user_id) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchases_one_per_user UNIQUE (sale_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_purchases_sale_id ON purchases (sale_id);
CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases (user_id);