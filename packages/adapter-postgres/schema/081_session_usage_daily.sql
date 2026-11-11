-- One incrementally maintained bucket per Session and local calendar day.
-- Token counts are deltas of the provider's cumulative thread counter, never inferred from elapsed time.
CREATE TABLE session_usage_daily (
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  day date NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK(cached_input_tokens>=0),
  cost_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK(cost_usd>=0),
  cost_reported boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,session_id,day),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE INDEX session_usage_daily_project_day ON session_usage_daily(project_id,day);
