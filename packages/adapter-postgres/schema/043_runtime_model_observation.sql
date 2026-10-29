-- Native thread/start acknowledgement is distinct from the configured Session model.
-- Historical rows stay unknown; model/list visibility never fills these columns.
ALTER TABLE runtime_session
  ADD COLUMN observed_model text,
  ADD COLUMN observed_provider text;
