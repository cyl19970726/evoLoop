CREATE TABLE role_definition (
  project_id uuid NOT NULL REFERENCES project(project_id), role_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), current_revision_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('candidate','trial','active','retirement-pending','retired','rejected','deferred')),
  proposed_by text NOT NULL, created_at_utc timestamptz NOT NULL,
  trial_started_at_utc timestamptz, review_at_utc timestamptz NOT NULL,
  merge_target_role_id uuid,
  PRIMARY KEY(project_id,role_id),
  FOREIGN KEY(project_id,merge_target_role_id) REFERENCES role_definition(project_id,role_id),
  CHECK(merge_target_role_id IS NULL OR merge_target_role_id<>role_id)
);
CREATE TABLE role_revision (
  project_id uuid NOT NULL, role_id uuid NOT NULL, revision_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), state text NOT NULL,
  proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object'),
  actor_id text NOT NULL, reason text NOT NULL, created_at_utc timestamptz NOT NULL,
  review_at_utc timestamptz NOT NULL, merge_target_role_id uuid,
  PRIMARY KEY(project_id,role_id,revision_id), UNIQUE(project_id,role_id,version),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id),
  FOREIGN KEY(project_id,merge_target_role_id) REFERENCES role_definition(project_id,role_id)
);
ALTER TABLE role_definition ADD CONSTRAINT role_current_revision_fk
  FOREIGN KEY(project_id,role_id,current_revision_id) REFERENCES role_revision(project_id,role_id,revision_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE role_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, role_id uuid NOT NULL, revision_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('accept-trial','reject','defer')),
  actor_id text NOT NULL, reason text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,decision_id),
  FOREIGN KEY(project_id,role_id,revision_id) REFERENCES role_revision(project_id,role_id,revision_id)
);
CREATE TABLE role_trial_review (
  project_id uuid NOT NULL, review_id uuid NOT NULL, role_id uuid NOT NULL, revision_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('continue-trial','activate','merge','retire')),
  effect_evidence text NOT NULL, effect_evidence_refs jsonb NOT NULL CHECK(jsonb_typeof(effect_evidence_refs)='array'),
  cost_evidence text NOT NULL, cost_evidence_refs jsonb NOT NULL CHECK(jsonb_typeof(cost_evidence_refs)='array'), baseline_comparison text NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,review_id),
  FOREIGN KEY(project_id,role_id,revision_id) REFERENCES role_revision(project_id,role_id,revision_id)
);
CREATE TABLE role_handoff (
  project_id uuid NOT NULL, handoff_id uuid NOT NULL, role_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('task','knowledge','session')),
  source_ref text NOT NULL, target_role_id uuid NOT NULL,
  observed_task_version integer, state text NOT NULL CHECK(state IN ('prepared','acknowledged')),
  prepared_at_utc timestamptz NOT NULL, acknowledged_at_utc timestamptz,
  PRIMARY KEY(project_id,handoff_id),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id),
  FOREIGN KEY(project_id,target_role_id) REFERENCES role_definition(project_id,role_id),
  CHECK(role_id<>target_role_id),
  CHECK((kind='task' AND observed_task_version>0) OR (kind<>'task' AND observed_task_version IS NULL)),
  CHECK((state='prepared' AND acknowledged_at_utc IS NULL) OR (state='acknowledged' AND acknowledged_at_utc IS NOT NULL))
);
CREATE TABLE role_handoff_event (
  project_id uuid NOT NULL, event_id uuid NOT NULL, handoff_id uuid NOT NULL,
  role_id uuid NOT NULL, state text NOT NULL CHECK(state IN ('prepared','acknowledged')),
  actor_id text NOT NULL, note text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,event_id),
  FOREIGN KEY(project_id,handoff_id) REFERENCES role_handoff(project_id,handoff_id),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id)
);
CREATE TABLE role_session_binding (
  project_id uuid NOT NULL, binding_id uuid NOT NULL, role_id uuid NOT NULL,
  session_id uuid NOT NULL, role_revision_id uuid NOT NULL,
  actor_id text NOT NULL, note text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,binding_id), UNIQUE(project_id,session_id),
  FOREIGN KEY(project_id,role_id,role_revision_id) REFERENCES role_revision(project_id,role_id,revision_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE INDEX role_state_idx ON role_definition(project_id,state,review_at_utc);
CREATE INDEX role_handoff_open_idx ON role_handoff(project_id,role_id) WHERE state='prepared';
CREATE FUNCTION validate_role_session_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM runtime_session s WHERE s.project_id=NEW.project_id AND s.session_id=NEW.session_id
    AND s.role_id=NEW.role_id::text AND s.state='ready' AND s.native_thread_id IS NOT NULL) THEN
    RAISE EXCEPTION 'role binding requires a ready owned runtime session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_binding_validate BEFORE INSERT ON role_session_binding FOR EACH ROW EXECUTE FUNCTION validate_role_session_binding();
CREATE FUNCTION protect_role_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_owner text; task_version integer; task_state text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'role handoff cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.project_id<>OLD.project_id OR NEW.handoff_id<>OLD.handoff_id OR NEW.role_id<>OLD.role_id
    OR NEW.kind<>OLD.kind OR NEW.source_ref<>OLD.source_ref OR NEW.target_role_id<>OLD.target_role_id
    OR NEW.observed_task_version IS DISTINCT FROM OLD.observed_task_version OR NEW.prepared_at_utc<>OLD.prepared_at_utc
    OR OLD.state<>'prepared' OR NEW.state<>'acknowledged') THEN
    RAISE EXCEPTION 'role handoff identity and transition are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='task' THEN
    SELECT owner,version,state INTO task_owner,task_version,task_state FROM task
      WHERE project_id=NEW.project_id AND task_id=NEW.source_ref::uuid;
    IF TG_OP='INSERT' AND (task_owner IS NULL OR task_owner<>NEW.role_id::text OR task_version<>NEW.observed_task_version OR task_state IN ('done','cancelled')) THEN
      RAISE EXCEPTION 'task handoff baseline does not match' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND (task_owner IS NULL OR task_owner<>NEW.target_role_id::text OR task_version<=NEW.observed_task_version) THEN
      RAISE EXCEPTION 'task handoff transfer is unconfirmed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_handoff_protect BEFORE INSERT OR UPDATE OR DELETE ON role_handoff FOR EACH ROW EXECUTE FUNCTION protect_role_handoff();
CREATE TRIGGER role_revision_immutable BEFORE UPDATE OR DELETE ON role_revision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER role_decision_immutable BEFORE UPDATE OR DELETE ON role_decision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER role_review_immutable BEFORE UPDATE OR DELETE ON role_trial_review FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER role_handoff_event_immutable BEFORE UPDATE OR DELETE ON role_handoff_event FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER role_binding_immutable BEFORE UPDATE OR DELETE ON role_session_binding FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
