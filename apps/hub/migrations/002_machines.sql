-- H1 PR3: machines, one-time join codes, the signing key for request identities, and per-project permissions for service identities.
CREATE TABLE hub_machine (
  machine_id uuid PRIMARY KEY,
  name text NOT NULL,
  -- The machine's own Ed25519 public key (SPKI PEM); the private key never leaves the machine. Null until the join code is used.
  public_key text,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'removed')),
  -- Roots the machine confirmed on itself when it joined. Informational here: the machine is the one that enforces them.
  allowed_roots text[] NOT NULL DEFAULT '{}',
  host_label text,
  created_by uuid NOT NULL REFERENCES hub_account(account_id),
  created_at timestamptz NOT NULL,
  joined_at timestamptz,
  removed_at timestamptz,
  last_seen_at timestamptz,
  CHECK (length(name) >= 1),
  CHECK (state <> 'active' OR public_key IS NOT NULL)
);

CREATE UNIQUE INDEX hub_machine_active_name_idx ON hub_machine(lower(name)) WHERE state <> 'removed';

-- One code per machine registration, shown once, valid ten minutes, used once. Only the SHA-256 is stored.
CREATE TABLE hub_machine_join_code (
  code_hash text PRIMARY KEY,
  machine_id uuid NOT NULL REFERENCES hub_machine(machine_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (length(code_hash) = 64)
);

CREATE INDEX hub_machine_join_code_machine_idx ON hub_machine_join_code(machine_id);

-- The Hub's Ed25519 key that signs short-lived request identities. `kid` lets a later key replace this one while machines keep the older public key.
CREATE TABLE hub_signing_key (
  kid text PRIMARY KEY,
  public_key text NOT NULL,
  private_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX hub_signing_key_active_idx ON hub_signing_key((true)) WHERE active;

-- A service identity (an agent) is read-only in a project unless it is granted object classes here. Decision-class commands only with an explicit grant (DEC-048).
ALTER TABLE hub_service_identity_project
  ADD COLUMN can_task boolean NOT NULL DEFAULT false,
  ADD COLUMN can_document boolean NOT NULL DEFAULT false,
  ADD COLUMN can_session boolean NOT NULL DEFAULT false,
  ADD COLUMN session_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN decisions boolean NOT NULL DEFAULT false;
