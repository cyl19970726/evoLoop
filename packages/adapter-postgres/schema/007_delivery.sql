CREATE TABLE outbox_delivery (
  project_id uuid NOT NULL, event_id uuid NOT NULL, consumer_id text NOT NULL CHECK(length(btrim(consumer_id))>0),
  state text NOT NULL CHECK(state IN ('pending','claimed','dispatching','applied','unknown','conflict','failed')),
  fence integer NOT NULL DEFAULT 0 CHECK(fence>=0), claim_token uuid, lease_owner text, lease_until_utc timestamptz,
  next_retry_at_utc timestamptz, last_reason text, updated_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,event_id,consumer_id),
  FOREIGN KEY(project_id,event_id) REFERENCES outbox_event(project_id,event_id),
  CHECK((state IN ('claimed','dispatching') AND claim_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_until_utc IS NOT NULL)
    OR (state NOT IN ('claimed','dispatching') AND claim_token IS NULL AND lease_owner IS NULL AND lease_until_utc IS NULL))
);
CREATE INDEX outbox_delivery_claim_idx ON outbox_delivery(project_id,consumer_id,state,updated_at_utc);
CREATE TABLE outbox_delivery_attempt (
  project_id uuid NOT NULL, attempt_id uuid NOT NULL, event_id uuid NOT NULL, consumer_id text NOT NULL,
  fence integer NOT NULL CHECK(fence>=0), action text NOT NULL CHECK(action IN ('dispatch','reconcile','retry','recover')),
  outcome text NOT NULL CHECK(outcome IN ('pending','claimed','dispatching','applied','unknown','conflict','failed')),
  reason text NOT NULL, remote_record_id text, actor_id text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,attempt_id),
  FOREIGN KEY(project_id,event_id,consumer_id) REFERENCES outbox_delivery(project_id,event_id,consumer_id)
);
CREATE INDEX outbox_delivery_attempt_read_idx ON outbox_delivery_attempt(project_id,event_id,consumer_id,created_at_utc,attempt_id);
CREATE TRIGGER immutable_outbox_delivery_attempt BEFORE UPDATE OR DELETE ON outbox_delivery_attempt FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TABLE collaboration_binding (
  project_id uuid NOT NULL, consumer_id text NOT NULL, task_id uuid NOT NULL,
  remote_record_id text NOT NULL, local_version integer NOT NULL CHECK(local_version>0),
  remote_operation_id text NOT NULL, remote_version integer NOT NULL CHECK(remote_version>0),
  remote_modified_time text, confirmed_title text NOT NULL, confirmed_status text NOT NULL,
  updated_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,consumer_id,task_id), UNIQUE(project_id,consumer_id,remote_record_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id)
);
CREATE TABLE collaboration_incoming (
  project_id uuid NOT NULL, incoming_id uuid NOT NULL, consumer_id text NOT NULL,
  task_id uuid NOT NULL, remote_record_id text NOT NULL,
  observed_local_version integer NOT NULL CHECK(observed_local_version>0),
  observed_remote_operation_id text NOT NULL, observed_remote_modified_time text,
  actor_evidence jsonb, patch jsonb NOT NULL CHECK(jsonb_typeof(patch)='object'),
  review_only boolean NOT NULL, reason text, source_event_id text NOT NULL,
  operation_id uuid NOT NULL, state text NOT NULL CHECK(state IN ('pending','review-only','applied','rejected','conflict','unknown')),
  observed_at_utc timestamptz NOT NULL, reviewed_by text, reviewed_at_utc timestamptz,
  PRIMARY KEY(project_id,incoming_id), UNIQUE(project_id,consumer_id,source_event_id),
  UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id),
  CHECK((state IN ('pending','review-only') AND reviewed_by IS NULL AND reviewed_at_utc IS NULL)
    OR (state IN ('applied','rejected','conflict','unknown') AND reviewed_by IS NOT NULL AND reviewed_at_utc IS NOT NULL))
);
CREATE INDEX collaboration_incoming_pending_idx ON collaboration_incoming(project_id,consumer_id,state,observed_at_utc);
CREATE TABLE collaboration_incoming_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, incoming_id uuid NOT NULL, consumer_id text NOT NULL,
  operation_id uuid NOT NULL, state text NOT NULL CHECK(state IN ('applied','rejected','conflict','unknown')),
  actor_id text NOT NULL, reason text NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,decision_id),
  FOREIGN KEY(project_id,incoming_id) REFERENCES collaboration_incoming(project_id,incoming_id)
);
CREATE TRIGGER immutable_collaboration_incoming_decision BEFORE UPDATE OR DELETE ON collaboration_incoming_decision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
