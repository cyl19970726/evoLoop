-- A typed, source-bound proof and one-shot permit on the original dispatch.
-- Legacy unknown operations have no proof and cannot be replayed.
ALTER TABLE runtime_run ADD COLUMN pre_turn_proof jsonb;
ALTER TABLE session_message_processing ADD COLUMN pre_turn_proof jsonb;

-- Keep the proof on the original row, with a separately immutable review event.
-- This is an invariant for trusted database writers; HTTP still authenticates
-- reviewer and exact Session grant before creating that event.
CREATE FUNCTION pre_turn_continuation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_status text; next_status text; subject_id uuid; review_kind text; gate record; owned_thread text;
BEGIN
  IF OLD.pre_turn_proof IS NOT DISTINCT FROM NEW.pre_turn_proof THEN RETURN NEW; END IF;
  IF NEW.pre_turn_proof IS NULL OR jsonb_typeof(NEW.pre_turn_proof)<>'object' THEN
    RAISE EXCEPTION 'pre-turn proof cannot be removed or malformed' USING ERRCODE='23514';
  END IF;
  previous_status:=OLD.pre_turn_proof->>'status';
  next_status:=NEW.pre_turn_proof->>'status';
  SELECT native_thread_id INTO owned_thread FROM runtime_session WHERE project_id=NEW.project_id
    AND session_id=NEW.session_id;
  IF NEW.pre_turn_proof->>'threadId' IS DISTINCT FROM owned_thread OR
     NEW.pre_turn_proof->>'code' IS DISTINCT FROM '-32600' OR
     jsonb_typeof(NEW.pre_turn_proof->'requestId') IS DISTINCT FROM 'number' OR
     (NEW.pre_turn_proof->>'requestId')::bigint<1 THEN
    RAISE EXCEPTION 'pre-turn proof lacks exact native refusal identity' USING ERRCODE='23514';
  END IF;
  IF NEW.native_turn_id IS NOT NULL AND next_status<>'consumed' OR
     NEW.pre_turn_proof->>'operationId' IS DISTINCT FROM NEW.operation_id::text OR
     (OLD.pre_turn_proof IS NOT NULL AND
      (NEW.pre_turn_proof->>'operationId' IS DISTINCT FROM OLD.pre_turn_proof->>'operationId' OR
       NEW.pre_turn_proof->>'threadId' IS DISTINCT FROM OLD.pre_turn_proof->>'threadId' OR
       NEW.pre_turn_proof->>'inputHash' IS DISTINCT FROM OLD.pre_turn_proof->>'inputHash')) THEN
    RAISE EXCEPTION 'pre-turn proof changed original identity or bound Turn' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='runtime_run' THEN subject_id:=NEW.run_id;review_kind:='run.reviewed';
  ELSE subject_id:=NEW.message_id;review_kind:='message.preTurnReviewed';END IF;
  IF previous_status IS NULL AND next_status='observed' AND OLD.state='dispatching' AND
     NEW.state='unknown' AND NEW.native_turn_id IS NULL THEN RETURN NEW; END IF;
  IF previous_status='attempting' AND next_status='observed' AND OLD.state='unknown' AND
     NEW.state='unknown' AND NEW.native_turn_id IS NULL THEN RETURN NEW; END IF;
  IF previous_status='observed' AND next_status='approved' AND OLD.state='unknown' AND
     NEW.state='unknown' AND NEW.native_turn_id IS NULL THEN
    IF NEW.pre_turn_proof-ARRAY['status','decisionOperationId','reviewerActorId','evidenceRef',
        'decisionReason','gateVersionAtApproval'] IS DISTINCT FROM
       OLD.pre_turn_proof-ARRAY['status','decisionOperationId','reviewerActorId','evidenceRef',
        'decisionReason','gateVersionAtApproval'] THEN
      RAISE EXCEPTION 'pre-turn review changed native refusal evidence' USING ERRCODE='23514';
    END IF;
    SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id
      AND session_id=NEW.session_id FOR SHARE;
    IF gate.phase IS DISTINCT FROM 'blocked' OR gate.cause_id IS DISTINCT FROM subject_id OR
       gate.cause_kind IS DISTINCT FROM (CASE WHEN TG_TABLE_NAME='runtime_run' THEN 'run' ELSE 'message' END) OR
       NEW.pre_turn_proof->>'gateVersionAtApproval' IS DISTINCT FROM gate.version::text THEN
      RAISE EXCEPTION 'pre-turn continuation requires exact blocked gate' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM runtime_record_event e WHERE e.project_id=NEW.project_id
         AND e.session_id=NEW.session_id AND e.kind=review_kind
         AND (TG_TABLE_NAME<>'runtime_run' OR e.run_id=subject_id)
         AND e.actor_id=NEW.pre_turn_proof->>'reviewerActorId'
         AND e.detail::jsonb->>'decisionOperationId'=NEW.pre_turn_proof->>'decisionOperationId'
         AND e.detail::jsonb->>'originalOperationId'=NEW.operation_id::text
         AND e.detail::jsonb->>'requestId'=NEW.pre_turn_proof->>'requestId'
         AND e.detail::jsonb->>'observedAtUtc'=NEW.pre_turn_proof->>'observedAtUtc'
         AND (TG_TABLE_NAME='runtime_run' OR e.detail::jsonb->>'messageId'=subject_id::text)) THEN
      RAISE EXCEPTION 'pre-turn continuation requires durable review event' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF previous_status='approved' AND next_status='attempting' AND OLD.state='unknown' AND
     NEW.state='unknown' AND NEW.native_turn_id IS NULL AND
     NEW.pre_turn_proof-'status'=OLD.pre_turn_proof-'status' THEN RETURN NEW; END IF;
  IF previous_status IN ('observed','approved','attempting') AND next_status='consumed' AND
     ((NEW.state='running' AND NEW.native_turn_id IS NOT NULL) OR
      (previous_status='attempting' AND NEW.state='unknown' AND NEW.native_turn_id IS NULL)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid pre-turn continuation transition' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER runtime_run_pre_turn_guard BEFORE UPDATE OF pre_turn_proof ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION pre_turn_continuation_guard();
CREATE TRIGGER session_message_pre_turn_guard BEFORE UPDATE OF pre_turn_proof ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION pre_turn_continuation_guard();
