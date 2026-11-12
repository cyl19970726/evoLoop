-- A direct start that is provably refused before anything reaches the runtime (the Session got a Turn after the person saw it idle,
-- or its primary Turn is not bound yet) is saved as one queued ordinary message with the input's own ID. The receipt row has no
-- processing slot of its own, so the start shape must allow "rejected, no processing, source is the queued message".
ALTER TABLE session_direct_input DROP CONSTRAINT session_direct_input_check;
ALTER TABLE session_direct_input ADD CONSTRAINT session_direct_input_check CHECK (
  (mode='start' AND source_kind='message' AND source_id=input_id AND processing_id IS NOT NULL AND expected_turn_id IS NULL)
  OR (mode='steer' AND expected_turn_id IS NOT NULL)
  OR (mode='start' AND state='rejected' AND source_kind='message' AND source_id=input_id AND processing_id IS NULL AND expected_turn_id IS NULL));
