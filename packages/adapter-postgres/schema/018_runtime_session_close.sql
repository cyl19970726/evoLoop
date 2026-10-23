ALTER TABLE runtime_session DROP CONSTRAINT runtime_session_state_check;
ALTER TABLE runtime_session ADD CONSTRAINT runtime_session_state_check
  CHECK (state IN ('reserved','creating','ready','closing','unknown','closed'));
ALTER TABLE runtime_session ADD COLUMN close_operation_id uuid;
ALTER TABLE runtime_session ADD COLUMN close_attempted_at timestamptz;
ALTER TABLE runtime_session ADD COLUMN close_verified_at timestamptz;
CREATE UNIQUE INDEX runtime_session_close_operation_unique ON runtime_session(project_id,close_operation_id)
  WHERE close_operation_id IS NOT NULL;
ALTER TABLE runtime_session ADD CONSTRAINT runtime_session_close_consistency CHECK (
  (state <> 'closing' OR (close_operation_id IS NOT NULL AND native_thread_id IS NOT NULL))
  AND (close_attempted_at IS NULL OR close_operation_id IS NOT NULL)
  AND (close_verified_at IS NULL OR (close_operation_id IS NOT NULL AND state='closed'))
  AND (state <> 'closed' OR close_operation_id IS NULL OR close_verified_at IS NOT NULL)
);
CREATE FUNCTION protect_runtime_close_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.close_operation_id IS NOT NULL AND NEW.close_operation_id IS DISTINCT FROM OLD.close_operation_id)
    OR (OLD.close_attempted_at IS NOT NULL AND NEW.close_attempted_at IS DISTINCT FROM OLD.close_attempted_at)
    OR (OLD.close_verified_at IS NOT NULL AND NEW.close_verified_at IS DISTINCT FROM OLD.close_verified_at) THEN
    RAISE EXCEPTION 'runtime close evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_close_identity BEFORE UPDATE ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION protect_runtime_close_identity();
