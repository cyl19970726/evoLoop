-- Stable business domains and reviewed host links. Existing Tasks retain a NULL domain.
CREATE TABLE business_domain (
  project_id uuid NOT NULL REFERENCES project(project_id), domain_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), current_revision_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('active','retired')),
  PRIMARY KEY(project_id,domain_id)
);
CREATE TABLE business_domain_revision (
  project_id uuid NOT NULL, domain_id uuid NOT NULL, revision_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), title text NOT NULL,
  role_id uuid, routing_reason text NOT NULL, authorization_evidence text NOT NULL,
  state text NOT NULL CHECK(state IN ('active','retired')),
  actor_id text NOT NULL, reason text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,domain_id,revision_id), UNIQUE(project_id,domain_id,version),
  FOREIGN KEY(project_id,domain_id) REFERENCES business_domain(project_id,domain_id),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id)
);
ALTER TABLE business_domain ADD CONSTRAINT business_domain_current_fk
  FOREIGN KEY(project_id,domain_id,current_revision_id)
  REFERENCES business_domain_revision(project_id,domain_id,revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE task ADD COLUMN domain_id uuid;
ALTER TABLE task_revision ADD COLUMN domain_id uuid;
ALTER TABLE task ADD CONSTRAINT task_domain_fk FOREIGN KEY(project_id,domain_id)
  REFERENCES business_domain(project_id,domain_id);
ALTER TABLE task_revision ADD CONSTRAINT task_revision_domain_fk FOREIGN KEY(project_id,domain_id)
  REFERENCES business_domain(project_id,domain_id);

CREATE TABLE role_host_link (
  project_id uuid NOT NULL, link_id uuid NOT NULL, role_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('registered','verified','revoked')),
  PRIMARY KEY(project_id,link_id), UNIQUE(project_id,link_id,role_id),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id)
);
CREATE TABLE role_host_link_revision (
  project_id uuid NOT NULL, link_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  role_id uuid NOT NULL, host jsonb NOT NULL CHECK(jsonb_typeof(host)='object'),
  claimed_capabilities jsonb NOT NULL CHECK(jsonb_typeof(claimed_capabilities)='array'),
  verified_capabilities jsonb NOT NULL CHECK(jsonb_typeof(verified_capabilities)='array'),
  evidence text, observer text, observed_at_utc timestamptz,
  state text NOT NULL CHECK(state IN ('registered','verified','revoked')),
  actor_id text NOT NULL, reason text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,link_id,version),
  FOREIGN KEY(project_id,link_id,role_id) REFERENCES role_host_link(project_id,link_id,role_id),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id),
  CHECK((host->>'kind'='owned' AND host ? 'sessionId' AND NOT (host ? 'ref')) OR
        (host->>'kind'='external' AND host->>'provider'='codex-desktop' AND host ? 'ref' AND NOT (host ? 'sessionId'))),
  CHECK(jsonb_array_length(claimed_capabilities)<=6 AND jsonb_array_length(verified_capabilities)<=6),
  CHECK(verified_capabilities <@ claimed_capabilities),
  CHECK(host->>'kind'<>'external' OR
        (NOT (claimed_capabilities ?| ARRAY['start','send','interrupt']) AND
         NOT (verified_capabilities ?| ARRAY['start','send','interrupt']))),
  CHECK((state='registered' AND observer IS NULL AND evidence IS NULL AND observed_at_utc IS NULL)
      OR state<>'registered')
);
CREATE INDEX business_domain_role_idx ON business_domain_revision(project_id,role_id);
CREATE INDEX role_host_link_role_idx ON role_host_link(project_id,role_id);
CREATE FUNCTION validate_role_host_link_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'revoked' AND NEW.host->>'kind'='owned' AND NOT EXISTS (
    SELECT 1 FROM runtime_session s JOIN role_session_binding b
      ON b.project_id=s.project_id AND b.session_id=s.session_id AND b.role_id=NEW.role_id
    WHERE s.project_id=NEW.project_id AND s.session_id=(NEW.host->>'sessionId')::uuid
      AND s.role_id=NEW.role_id::text AND s.state='ready' AND s.native_thread_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'owned host link requires ready formally bound Role Session' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_host_link_validate BEFORE INSERT ON role_host_link_revision
  FOR EACH ROW EXECUTE FUNCTION validate_role_host_link_revision();
CREATE TRIGGER business_domain_revision_immutable BEFORE UPDATE OR DELETE ON business_domain_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER role_host_link_revision_immutable BEFORE UPDATE OR DELETE ON role_host_link_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
