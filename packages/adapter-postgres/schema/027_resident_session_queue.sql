CREATE TABLE resident_queue (
  project_id uuid NOT NULL REFERENCES project(project_id), queue_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), adopted_version integer,
  adopted_by text, adopted_at timestamptz,
  reason text NOT NULL CHECK(length(btrim(reason))>0), actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,queue_id), CHECK(adopted_version IS NULL OR adopted_version<=version),
  CHECK((adopted_version IS NULL)=(adopted_by IS NULL)), CHECK((adopted_version IS NULL)=(adopted_at IS NULL))
);
CREATE TABLE resident_queue_revision (
  project_id uuid NOT NULL, queue_id uuid NOT NULL, version integer NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason))>0), actor_id text NOT NULL,
  ordered_entry_ids uuid[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,queue_id,version),
  FOREIGN KEY(project_id,queue_id) REFERENCES resident_queue(project_id,queue_id)
);
CREATE TABLE resident_queue_entry (
  project_id uuid NOT NULL, queue_id uuid NOT NULL, entry_id uuid NOT NULL,
  task_id uuid NOT NULL, task_revision_id uuid NOT NULL, session_id uuid NOT NULL, role_id uuid NOT NULL,
  position integer NOT NULL CHECK(position>=0), depends_on uuid[] NOT NULL DEFAULT '{}',
  consumer_id text NOT NULL, use_required boolean NOT NULL, release_rule text NOT NULL CHECK(release_rule IN ('accepted','bounded_decision')),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','held','claimed','released')),
  hold_code text, hold_reason text, claim_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,queue_id,entry_id),
  UNIQUE(project_id,queue_id,position), UNIQUE(project_id,queue_id,task_id),
  FOREIGN KEY(project_id,queue_id) REFERENCES resident_queue(project_id,queue_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id),
  CHECK((state='claimed')=(claim_id IS NOT NULL)), CHECK((hold_code IS NULL)=(hold_reason IS NULL))
);
CREATE INDEX resident_queue_entry_next ON resident_queue_entry(project_id,queue_id,state,position);
CREATE TABLE resident_queue_claim (
  project_id uuid NOT NULL, queue_id uuid NOT NULL, entry_id uuid NOT NULL, claim_id uuid NOT NULL,
  task_id uuid NOT NULL, task_revision_id uuid NOT NULL, session_id uuid NOT NULL, role_id uuid NOT NULL,
  run_id uuid NOT NULL, operation_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('intent','dispatching','running','terminal','unknown','released')),
  native_turn_id text, reason text, delivery_id uuid, observation_id uuid, closure_id uuid, bounded_decision_id uuid,
  release_kind text CHECK(release_kind IN ('accepted','bounded')),
  claimed_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  PRIMARY KEY(project_id,claim_id), UNIQUE(project_id,operation_id), UNIQUE(project_id,run_id),
  FOREIGN KEY(project_id,queue_id,entry_id) REFERENCES resident_queue_entry(project_id,queue_id,entry_id),
  CHECK((state='released')=(released_at IS NOT NULL)),
  CHECK((state='released')=(release_kind IS NOT NULL))
);
CREATE UNIQUE INDEX resident_queue_occupied_session ON resident_queue_claim(project_id,session_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX resident_queue_occupied_task ON resident_queue_claim(project_id,task_id) WHERE released_at IS NULL;
CREATE INDEX resident_queue_reconcile ON resident_queue_claim(project_id,state,claimed_at) WHERE released_at IS NULL;
CREATE TABLE resident_queue_release_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, claim_id uuid NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>0),
  next_responsibility text NOT NULL CHECK(length(btrim(next_responsibility))>0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,decision_id),
  UNIQUE(project_id,claim_id), FOREIGN KEY(project_id,claim_id) REFERENCES resident_queue_claim(project_id,claim_id)
);
CREATE TRIGGER resident_queue_release_decision_immutable BEFORE UPDATE OR DELETE ON resident_queue_release_decision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER resident_queue_revision_immutable BEFORE UPDATE OR DELETE ON resident_queue_revision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE FUNCTION protect_resident_queue_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'resident queue claim cannot be deleted' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.project_id,NEW.queue_id,NEW.entry_id,NEW.claim_id,NEW.task_id,NEW.task_revision_id,NEW.session_id,NEW.role_id,NEW.run_id,NEW.operation_id,NEW.claimed_at)
     IS DISTINCT FROM ROW(OLD.project_id,OLD.queue_id,OLD.entry_id,OLD.claim_id,OLD.task_id,OLD.task_revision_id,OLD.session_id,OLD.role_id,OLD.run_id,OLD.operation_id,OLD.claimed_at)
     OR (OLD.native_turn_id IS NOT NULL AND NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id)
     OR (OLD.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'resident queue claim identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resident_queue_claim_identity BEFORE UPDATE OR DELETE ON resident_queue_claim FOR EACH ROW EXECUTE FUNCTION protect_resident_queue_claim();
