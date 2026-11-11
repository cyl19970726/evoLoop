-- Candidate review remains historical evidence after formal review begins. A Delivery can have
-- one active candidate and one active formal arrangement; closure is governed by the active formal
-- arrangement when present, otherwise by the active candidate arrangements. Every effective
-- arrangement still needs its own linked, recipient-matched used observation.
CREATE OR REPLACE FUNCTION guard_acceptance_relay_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH active AS (
      SELECT * FROM task_acceptance_relay a
      WHERE a.project_id=NEW.project_id AND a.task_id=NEW.task_id
        AND a.delivery_id=NEW.delivery_id AND a.state NOT IN ('superseded','released')
    )
    SELECT 1 FROM active a
    WHERE a.stage=CASE WHEN EXISTS(SELECT 1 FROM active WHERE stage='formal') THEN 'formal' ELSE a.stage END
      AND NOT EXISTS (
        SELECT 1 FROM task_acceptance_observation_link l
        JOIN consumer_observation o ON o.project_id=l.project_id AND o.observation_id=l.observation_id
        WHERE l.project_id=a.project_id AND l.relay_id=a.relay_id AND o.result='used'
          AND o.delivery_id=a.delivery_id AND o.observer=a.recipient_actor_id
      )
  ) THEN
    RAISE EXCEPTION 'effective acceptance arrangement lacks linked consumer use' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
