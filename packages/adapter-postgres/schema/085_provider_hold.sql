-- A provider-wide pause of new native Turns, opened by the first quota/authentication failure of that provider.
-- Every Session of the provider would fail the same way, so none starts new work until one decision frees them all.
-- At most one active hold per provider; released holds stay as history with who released it and what the release did.
CREATE TABLE runtime_provider_hold (
  project_id uuid NOT NULL REFERENCES project(project_id), hold_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('codex','claude')),
  state text NOT NULL CHECK(state IN ('held','released')),
  category text NOT NULL CHECK(category IN ('quota_exhausted','authentication_failed')),
  cause_session_id uuid, cause_message_id uuid,
  reason text NOT NULL CHECK(length(btrim(reason))>0),
  version integer NOT NULL CHECK(version>0),
  opened_at timestamptz NOT NULL, released_at timestamptz, released_by text, release_reason text,
  release_summary jsonb,
  PRIMARY KEY(project_id,hold_id),
  CHECK((state='held' AND released_at IS NULL) OR (state='released' AND released_at IS NOT NULL AND released_by IS NOT NULL))
);
CREATE UNIQUE INDEX runtime_provider_hold_active ON runtime_provider_hold(project_id,provider) WHERE state='held';
