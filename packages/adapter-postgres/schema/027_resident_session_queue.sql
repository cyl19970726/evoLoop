CREATE TABLE resident_queue (
  project_id uuid NOT NULL REFERENCES project(project_id), queue_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), adopted_version integer,
  max_runs integer NOT NULL CHECK(max_runs BETWEEN 1 AND 100),
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
  task_id uuid NOT NULL, task_revision_id uuid NOT NULL, source_input_json text NOT NULL,
  session_id uuid NOT NULL, role_id uuid NOT NULL,
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
  CHECK((state IN ('claimed','released'))=(claim_id IS NOT NULL)), CHECK((hold_code IS NULL)=(hold_reason IS NULL))
);
CREATE INDEX resident_queue_entry_next ON resident_queue_entry(project_id,queue_id,state,position);
CREATE TABLE resident_queue_entry_amendment (
  project_id uuid NOT NULL,queue_id uuid NOT NULL,entry_id uuid NOT NULL,queue_version integer NOT NULL,
  old_task_revision_id uuid NOT NULL,new_task_revision_id uuid NOT NULL,
  old_source_input_json text NOT NULL,new_source_input_json text NOT NULL,
  actor_id text NOT NULL,reason text NOT NULL CHECK(length(btrim(reason))>0),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,queue_id,entry_id,queue_version),
  FOREIGN KEY(project_id,queue_id,entry_id) REFERENCES resident_queue_entry(project_id,queue_id,entry_id)
);
CREATE TABLE resident_queue_claim (
  project_id uuid NOT NULL, queue_id uuid NOT NULL, entry_id uuid NOT NULL, claim_id uuid NOT NULL,
  task_id uuid NOT NULL, session_id uuid NOT NULL, role_id uuid NOT NULL,
  release_kind text CHECK(release_kind IN ('accepted','bounded')),
  delivery_id uuid, observation_id uuid, closure_id uuid, bounded_decision_id uuid,
  claimed_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  PRIMARY KEY(project_id,claim_id), UNIQUE(project_id,queue_id,entry_id),
  FOREIGN KEY(project_id,queue_id,entry_id) REFERENCES resident_queue_entry(project_id,queue_id,entry_id),
  CHECK((released_at IS NULL)=(release_kind IS NULL)),
  CHECK(release_kind IS DISTINCT FROM 'accepted' OR (delivery_id IS NOT NULL AND closure_id IS NOT NULL)),
  CHECK(release_kind IS DISTINCT FROM 'bounded' OR bounded_decision_id IS NOT NULL)
);
CREATE UNIQUE INDEX resident_queue_occupied_session ON resident_queue_claim(project_id,session_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX resident_queue_occupied_task ON resident_queue_claim(project_id,task_id) WHERE released_at IS NULL;
CREATE TABLE resident_queue_attempt (
  project_id uuid NOT NULL, claim_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>0),
  run_id uuid NOT NULL, operation_id uuid NOT NULL, task_revision_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,claim_id,sequence), UNIQUE(project_id,run_id), UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,claim_id) REFERENCES resident_queue_claim(project_id,claim_id)
);
CREATE TABLE resident_queue_release_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, claim_id uuid NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>0),
  next_responsibility text NOT NULL CHECK(length(btrim(next_responsibility))>0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,decision_id),
  UNIQUE(project_id,claim_id), FOREIGN KEY(project_id,claim_id) REFERENCES resident_queue_claim(project_id,claim_id)
);
CREATE TRIGGER resident_queue_revision_immutable BEFORE UPDATE OR DELETE ON resident_queue_revision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER resident_queue_amendment_immutable BEFORE UPDATE OR DELETE ON resident_queue_entry_amendment FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER resident_queue_attempt_immutable BEFORE UPDATE OR DELETE ON resident_queue_attempt FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER resident_queue_release_decision_immutable BEFORE UPDATE OR DELETE ON resident_queue_release_decision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE FUNCTION protect_resident_queue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'resident queue cannot be deleted' USING ERRCODE='23514'; END IF;
  IF NEW.project_id<>OLD.project_id OR NEW.queue_id<>OLD.queue_id OR NEW.max_runs<>OLD.max_runs
    OR NEW.created_at<>OLD.created_at OR NEW.version NOT IN (OLD.version,OLD.version+1)
    OR (NEW.version=OLD.version AND (NEW.reason<>OLD.reason OR NEW.actor_id<>OLD.actor_id))
    OR (NEW.version=OLD.version+1 AND NEW.adopted_version IS NOT NULL) THEN
    RAISE EXCEPTION 'resident queue identity and budget are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resident_queue_identity BEFORE UPDATE OR DELETE ON resident_queue FOR EACH ROW EXECUTE FUNCTION protect_resident_queue();
CREATE FUNCTION protect_resident_queue_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'resident queue claim cannot be deleted' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.project_id,NEW.queue_id,NEW.entry_id,NEW.claim_id,NEW.task_id,NEW.session_id,NEW.role_id,NEW.claimed_at)
     IS DISTINCT FROM ROW(OLD.project_id,OLD.queue_id,OLD.entry_id,OLD.claim_id,OLD.task_id,OLD.session_id,OLD.role_id,OLD.claimed_at)
     OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'resident queue claim may only be released once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resident_queue_claim_identity BEFORE UPDATE OR DELETE ON resident_queue_claim FOR EACH ROW EXECUTE FUNCTION protect_resident_queue_claim();
CREATE FUNCTION enforce_resident_queue_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer; used integer; queue uuid; claim_used integer;
BEGIN
  SELECT q.max_runs,q.queue_id INTO maximum,queue FROM resident_queue_claim c JOIN resident_queue q ON q.project_id=c.project_id AND q.queue_id=c.queue_id
    WHERE c.project_id=NEW.project_id AND c.claim_id=NEW.claim_id FOR UPDATE OF q;
  SELECT count(*) INTO used FROM resident_queue_attempt a JOIN resident_queue_claim c ON c.project_id=a.project_id AND c.claim_id=a.claim_id
    WHERE c.project_id=NEW.project_id AND c.queue_id=queue;
  SELECT count(*) INTO claim_used FROM resident_queue_attempt WHERE project_id=NEW.project_id AND claim_id=NEW.claim_id;
  IF maximum IS NULL OR used>=maximum THEN RAISE EXCEPTION 'resident queue run budget exhausted' USING ERRCODE='23514'; END IF;
  IF NEW.sequence<>claim_used+1 THEN RAISE EXCEPTION 'resident queue attempt sequence mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resident_queue_attempt_budget BEFORE INSERT ON resident_queue_attempt FOR EACH ROW EXECUTE FUNCTION enforce_resident_queue_budget();
