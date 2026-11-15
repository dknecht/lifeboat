-- Passkeys (WebAuthn credentials) a user can sign in with in place of a password.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                  -- the credential ID, base64url
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,             -- the COSE public key, base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

-- Short-lived challenges issued for a passkey ceremony. Each is used once.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL for a sign-in, where the user is not yet known
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
