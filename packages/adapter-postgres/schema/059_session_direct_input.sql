-- A submission is evidence attached to the existing primary Run or message processing.
-- It is never a second writer slot or a pending-message queue.
CREATE TABLE session_direct_input (
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  input_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL CHECK(length(btrim(actor_id)) BETWEEN 1 AND 240),
  content text NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 16000),
  mode text NOT NULL CHECK(mode IN ('steer','start')),
  source_kind text NOT NULL CHECK(source_kind IN ('run','message')),
  source_id uuid NOT NULL,
  processing_id uuid,
  expected_turn_id text,
  actual_turn_id text,
  native_item_id text,
  state text NOT NULL CHECK(state IN ('pending','attempted','accepted','rejected','unknown')),
  reason text CHECK(reason IS NULL OR length(reason)<=4000),
  version integer NOT NULL CHECK(version>0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,input_id),
  UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK ((mode='start' AND source_kind='message' AND source_id=input_id AND processing_id IS NOT NULL AND expected_turn_id IS NULL)
    OR (mode='steer' AND expected_turn_id IS NOT NULL)),
  CHECK (state<>'accepted' OR actual_turn_id IS NOT NULL)
);
CREATE INDEX session_direct_input_by_session ON session_direct_input(project_id,session_id,created_at DESC,input_id DESC);
CREATE INDEX session_direct_input_by_source ON session_direct_input(project_id,source_kind,source_id,created_at,input_id);

CREATE FUNCTION protect_session_direct_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'direct input cannot be deleted' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.project_id,NEW.session_id,NEW.input_id,NEW.operation_id,NEW.actor_id,NEW.content,
    NEW.mode,NEW.source_kind,NEW.source_id,NEW.processing_id,NEW.expected_turn_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.project_id,OLD.session_id,OLD.input_id,OLD.operation_id,OLD.actor_id,OLD.content,
    OLD.mode,OLD.source_kind,OLD.source_id,OLD.processing_id,OLD.expected_turn_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
    OR (OLD.actual_turn_id IS NOT NULL AND NEW.actual_turn_id IS DISTINCT FROM OLD.actual_turn_id)
    OR (OLD.native_item_id IS NOT NULL AND NEW.native_item_id IS DISTINCT FROM OLD.native_item_id)
    OR NOT ((OLD.state='pending' AND NEW.state IN ('attempted','rejected'))
      OR (OLD.state='attempted' AND NEW.state IN ('accepted','rejected','unknown'))
      OR (OLD.state='unknown' AND NEW.state IN ('accepted','rejected','unknown'))
      OR (OLD.state='accepted' AND NEW.state='accepted' AND OLD.native_item_id IS NULL AND NEW.native_item_id IS NOT NULL))
    THEN RAISE EXCEPTION 'direct input identity or transition is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_direct_input_identity BEFORE UPDATE OR DELETE ON session_direct_input
  FOR EACH ROW EXECUTE FUNCTION protect_session_direct_input();

-- An original direct start may have been marked unknown before its native reply was
-- recovered. Release only that exact gate after terminal evidence or a proved
-- pre-Turn rejection. A late old outcome cannot clear a later gate or claim.
CREATE FUNCTION release_reconciled_direct_gate(p_project uuid,p_session uuid,p_message uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE gate record;
BEGIN
  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=p_project AND session_id=p_session FOR UPDATE;
  IF gate.phase<>'blocked' OR gate.cause_kind<>'message' OR gate.cause_id IS DISTINCT FROM p_message
    OR gate.claim_id IS NOT NULL OR gate.resume_message_id IS NOT NULL THEN RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM session_direct_input d JOIN session_message_processing p
      ON p.project_id=d.project_id AND p.message_id=d.input_id AND p.processing_id=d.processing_id
      WHERE d.project_id=p_project AND d.session_id=p_session AND d.input_id=p_message
        AND d.mode='start' AND d.source_kind='message' AND d.source_id=p_message AND (
          (d.state='accepted' AND p.state='completed' AND p.native_turn_id=d.actual_turn_id)
          OR (d.state='rejected' AND p.state='failed' AND p.native_turn_id IS NULL)))
    THEN RETURN; END IF;
  UPDATE session_recovery_gate SET phase='open',cause_kind=NULL,cause_id=NULL,cause_state=NULL,
    reason='Exact direct input original reconciled',decision_operation_id=NULL,version=version+1,updated_at=now()
    WHERE project_id=p_project AND session_id=p_session AND version=gate.version AND phase='blocked'
      AND cause_kind='message' AND cause_id=p_message;
END $$;
CREATE FUNCTION direct_input_gate_after_processing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.state IN ('completed','failed') AND NEW.state<>OLD.state THEN
    PERFORM release_reconciled_direct_gate(NEW.project_id,NEW.session_id,NEW.message_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_direct_input_gate_after_processing AFTER UPDATE OF state ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION direct_input_gate_after_processing();
CREATE FUNCTION direct_input_gate_after_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.state IN ('accepted','rejected') AND NEW.state<>OLD.state AND NEW.mode='start' THEN
    PERFORM release_reconciled_direct_gate(NEW.project_id,NEW.session_id,NEW.source_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_direct_input_gate_after_receipt AFTER UPDATE OF state ON session_direct_input
  FOR EACH ROW EXECUTE FUNCTION direct_input_gate_after_receipt();
