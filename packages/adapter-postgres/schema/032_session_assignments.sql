-- Presentation metadata belongs to the exact Session or external HostLink, never the native chat title.
CREATE TABLE session_profile (
  project_id uuid NOT NULL REFERENCES project(project_id), target_kind text NOT NULL CHECK(target_kind IN ('owned','external')),
  target_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), display_name text NOT NULL CHECK(length(btrim(display_name)) BETWEEN 1 AND 240),
  purpose text NOT NULL CHECK(length(purpose)<=4000), membership text NOT NULL CHECK(membership IN ('current','historical','unclassified')),
  tenure text NOT NULL CHECK(tenure IN ('resident','temporary','unknown')), actor_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000), updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,target_kind,target_id)
);
CREATE TABLE session_profile_revision (LIKE session_profile INCLUDING CONSTRAINTS);
ALTER TABLE session_profile_revision ADD PRIMARY KEY(project_id,target_kind,target_id,version);
ALTER TABLE session_profile_revision ADD FOREIGN KEY(project_id,target_kind,target_id)
  REFERENCES session_profile(project_id,target_kind,target_id);
CREATE TRIGGER session_profile_revision_immutable BEFORE UPDATE OR DELETE ON session_profile_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE TABLE task_session_assignment (
  project_id uuid NOT NULL, task_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), task_revision_id uuid NOT NULL,
  target_kind text NOT NULL CHECK(target_kind IN ('owned','external')), target_id uuid NOT NULL,
  recipient_actor_id text, state text NOT NULL CHECK(state IN ('assigned','accepted','released')),
  ack_method text CHECK(ack_method IN ('direct','lead-observed')), ack_actor_id text, ack_observer_actor_id text,
  ack_evidence text, ack_source_ref text, ack_at timestamptz,
  actor_id text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000), updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id), FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  CHECK((ack_method IS NULL)=(ack_observer_actor_id IS NULL)),
  CHECK((ack_method IS NULL)=(ack_evidence IS NULL)), CHECK((ack_method IS NULL)=(ack_at IS NULL)),
  CHECK(ack_method IS DISTINCT FROM 'direct' OR (ack_actor_id IS NOT NULL AND ack_actor_id=recipient_actor_id)),
  CHECK(ack_method IS DISTINCT FROM 'lead-observed' OR ack_actor_id IS NULL),
  CHECK(state IS DISTINCT FROM 'accepted' OR ack_method IS NOT NULL)
);
CREATE TABLE task_session_assignment_revision (LIKE task_session_assignment INCLUDING CONSTRAINTS);
ALTER TABLE task_session_assignment_revision ADD PRIMARY KEY(project_id,task_id,version);
ALTER TABLE task_session_assignment_revision ADD FOREIGN KEY(project_id,task_id)
  REFERENCES task_session_assignment(project_id,task_id);
CREATE INDEX task_assignment_target_idx ON task_session_assignment(project_id,target_kind,target_id,task_id);
CREATE TRIGGER task_session_assignment_revision_immutable BEFORE UPDATE OR DELETE ON task_session_assignment_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE FUNCTION validate_session_assignment_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_kind='owned' AND NOT EXISTS (SELECT 1 FROM runtime_session
    WHERE project_id=NEW.project_id AND session_id=NEW.target_id) THEN
    RAISE EXCEPTION 'owned Session target missing in project' USING ERRCODE='23503';
  END IF;
  IF NEW.target_kind='external' AND NOT EXISTS (SELECT 1 FROM role_host_link l
    JOIN role_host_link_revision r ON r.project_id=l.project_id AND r.link_id=l.link_id AND r.version=l.version
    WHERE l.project_id=NEW.project_id AND l.link_id=NEW.target_id AND r.host->>'kind'='external') THEN
    RAISE EXCEPTION 'external HostLink target missing in project' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_profile_target BEFORE INSERT OR UPDATE ON session_profile
  FOR EACH ROW EXECUTE FUNCTION validate_session_assignment_target();
CREATE TRIGGER task_assignment_target BEFORE INSERT OR UPDATE ON task_session_assignment
  FOR EACH ROW EXECUTE FUNCTION validate_session_assignment_target();

-- Installed after 030; journal entries expose invalidations without copying evidence bodies.
CREATE TRIGGER session_profile_observation AFTER INSERT OR UPDATE ON session_profile
  FOR EACH ROW EXECUTE FUNCTION record_session_observation_change();
CREATE TRIGGER task_assignment_observation AFTER INSERT OR UPDATE ON task_session_assignment
  FOR EACH ROW EXECUTE FUNCTION record_session_observation_change();
