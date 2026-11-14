CREATE TABLE hub_account (
  account_id uuid PRIMARY KEY,
  actor_id text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  is_hub_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (length(email) >= 3),
  CHECK (length(display_name) >= 1),
  CHECK (length(actor_id) >= 3)
);

CREATE TABLE hub_invite (
  invite_id uuid PRIMARY KEY,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES hub_account(account_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES hub_account(account_id),
  CHECK (length(email) >= 3),
  CHECK (length(token_hash) = 64)
);

CREATE INDEX hub_invite_email_idx ON hub_invite(email, accepted_at);

CREATE TABLE hub_login_session (
  session_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES hub_account(account_id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (length(token_hash) = 64)
);

CREATE INDEX hub_login_session_account_idx ON hub_login_session(account_id, revoked_at);

CREATE TABLE hub_project (
  project_id uuid PRIMARY KEY,
  name text NOT NULL,
  machine_id text,
  created_by uuid NOT NULL REFERENCES hub_account(account_id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (length(name) >= 1)
);

CREATE TABLE hub_project_member (
  project_id uuid NOT NULL REFERENCES hub_project(project_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES hub_account(account_id) ON DELETE CASCADE,
  can_task boolean NOT NULL DEFAULT false,
  can_document boolean NOT NULL DEFAULT false,
  can_session boolean NOT NULL DEFAULT false,
  session_ids text[] NOT NULL DEFAULT '{}',
  is_project_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, account_id),
  CHECK (is_project_admin OR can_task OR can_document OR can_session)
);

CREATE INDEX hub_project_member_account_idx ON hub_project_member(account_id);

CREATE TABLE hub_project_actor (
  project_id uuid NOT NULL REFERENCES hub_project(project_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human', 'service')),
  PRIMARY KEY (project_id, actor_id)
);

CREATE INDEX hub_project_actor_actor_idx ON hub_project_actor(actor_id);

CREATE TABLE hub_personal_token (
  token_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES hub_account(account_id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  project_id uuid REFERENCES hub_project(project_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK (length(name) >= 1),
  CHECK (length(token_hash) = 64)
);

CREATE INDEX hub_personal_token_account_idx ON hub_personal_token(account_id, revoked_at);

CREATE TABLE hub_service_identity (
  service_identity_id uuid PRIMARY KEY,
  actor_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  owner_account_id uuid NOT NULL REFERENCES hub_account(account_id),
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES hub_account(account_id),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (length(actor_id) >= 3),
  CHECK (length(display_name) >= 1),
  CHECK (length(purpose) >= 1),
  CHECK (length(token_hash) = 64)
);

CREATE INDEX hub_service_identity_owner_idx ON hub_service_identity(owner_account_id);

CREATE TABLE hub_service_identity_project (
  service_identity_id uuid NOT NULL REFERENCES hub_service_identity(service_identity_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES hub_project(project_id) ON DELETE CASCADE,
  PRIMARY KEY (service_identity_id, project_id)
);

CREATE TABLE hub_login_throttle (
  email_key text PRIMARY KEY,
  failed_count integer NOT NULL DEFAULT 0,
  last_failed_at timestamptz NOT NULL,
  blocked_until timestamptz,
  CHECK (failed_count >= 0)
);

CREATE TABLE hub_audit (
  audit_id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  actor_id text,
  action text NOT NULL,
  project_id uuid REFERENCES hub_project(project_id) ON DELETE SET NULL,
  subject text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX hub_audit_project_idx ON hub_audit(project_id, audit_id DESC);
CREATE INDEX hub_audit_occurred_idx ON hub_audit(occurred_at DESC, audit_id DESC);
