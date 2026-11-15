-- Releasing a stale or stuck acceptance arrangement. The closure guard (070) wants every effective arrangement of the Delivery's governing stage to
-- have a linked, recipient-matched use; an arrangement that was superseded in fact (an earlier formal check recorded notUsed before a fix was
-- merged) or got stuck (a blocked candidate whose message binding no longer matches) stayed effective for ever, because nothing moved it out of the
-- effective states. `acceptance.release` does, under review authority and with a reason that stays in this record.
CREATE TABLE task_acceptance_relay_release (
  project_id uuid NOT NULL, relay_id uuid NOT NULL, operation_id uuid NOT NULL, actor_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason))>0), from_state text NOT NULL, from_version integer NOT NULL, released_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,relay_id), UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,relay_id) REFERENCES task_acceptance_relay(project_id,relay_id)
);
CREATE TRIGGER task_acceptance_relay_release_immutable BEFORE UPDATE OR DELETE ON task_acceptance_relay_release
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
