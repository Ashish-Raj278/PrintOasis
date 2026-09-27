ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified SMALLINT NOT NULL DEFAULT 1
    CHECK (email_verified IN (0, 1));

CREATE TABLE IF NOT EXISTS account_tokens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_tokens_user_purpose_created
  ON account_tokens(user_id, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_tokens_expiry
  ON account_tokens(expires_at) WHERE used_at IS NULL;
