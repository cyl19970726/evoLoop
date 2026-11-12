-- Drain mode: a maintainer stops the instance from STARTING new Runs and message Turns (everything is still saved and
-- queued; work already running finishes), so a release can stop writes without waiting for a team that never goes idle.
-- One row for the whole instance, kept across restarts so a restart during a release does not resume starting work;
-- every start and release is also kept as an event with who did it, when and why.
CREATE TABLE instance_drain (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state text NOT NULL CHECK (state IN ('active','draining')),
  version integer NOT NULL CHECK (version > 0),
  actor_id text,
  reason text,
  changed_at timestamptz NOT NULL
);
INSERT INTO instance_drain(singleton,state,version,actor_id,reason,changed_at) VALUES(true,'active',1,NULL,NULL,now());
CREATE TABLE instance_drain_event (
  event_id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('start','release')),
  version integer NOT NULL,
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  at timestamptz NOT NULL
);
CREATE INDEX instance_drain_event_at ON instance_drain_event(at DESC);
CREATE TRIGGER instance_drain_event_immutable BEFORE UPDATE OR DELETE ON instance_drain_event
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
