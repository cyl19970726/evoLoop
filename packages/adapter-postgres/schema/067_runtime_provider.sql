-- Native runtime provider of each Session. Fixed when the Session is reserved: a Codex Thread and a
-- Claude session are different native objects, so a Session never changes provider. Existing rows
-- were all created through the Codex App Server.
ALTER TABLE runtime_session ADD COLUMN runtime_provider text NOT NULL DEFAULT 'codex'
  CHECK (runtime_provider IN ('codex','claude'));
CREATE FUNCTION protect_runtime_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runtime_provider IS DISTINCT FROM OLD.runtime_provider THEN
    RAISE EXCEPTION 'runtime session provider is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_provider_immutable BEFORE UPDATE ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION protect_runtime_provider();

-- Provider-reported accounting of the Run's bound terminal Turn. NULL means the provider reported
-- none (Codex App Server today); values are never estimated.
ALTER TABLE runtime_run ADD COLUMN usage jsonb
  CHECK (usage IS NULL OR (jsonb_typeof(usage)='object'
    AND jsonb_typeof(usage->'inputTokens')='number' AND jsonb_typeof(usage->'outputTokens')='number'));
ALTER TABLE runtime_run ADD COLUMN cost_usd numeric(14,6) CHECK (cost_usd IS NULL OR cost_usd >= 0);
