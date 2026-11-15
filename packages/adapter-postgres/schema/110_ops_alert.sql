-- Alerts that leave the workbench (defect/Task 5da8b6d9): one row per alert episode, so a restart never repeats a message and a recovery is sent once.
-- A row is opened when the system sees the condition (a provider pause opened, or no new Run for the stall time while work waits), and resolved when
-- it is over. Delivery is tracked separately for the opening message and the recovery message: attempts, the time it got through, and the last error.
-- Delivery failures never touch the thing being reported: this table is only read by the alert pump, and nothing waits on it.
CREATE TABLE ops_alert (
  project_id uuid NOT NULL REFERENCES project(project_id), alert_key text NOT NULL CHECK(length(alert_key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK(kind IN ('provider_hold','stall')),
  subject text NOT NULL DEFAULT '',
  state text NOT NULL CHECK(state IN ('open','resolved')),
  opened_at timestamptz NOT NULL, resolved_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  open_attempts integer NOT NULL DEFAULT 0 CHECK(open_attempts>=0), open_delivered_at timestamptz,
  resolved_attempts integer NOT NULL DEFAULT 0 CHECK(resolved_attempts>=0), resolved_delivered_at timestamptz,
  last_attempt_at timestamptz, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,alert_key),
  CHECK((state='open' AND resolved_at IS NULL) OR (state='resolved' AND resolved_at IS NOT NULL))
);
-- At most one open stall alert per project, and one open alert per provider hold key.
CREATE UNIQUE INDEX ops_alert_open_stall ON ops_alert(project_id) WHERE kind='stall' AND state='open';
CREATE INDEX ops_alert_undelivered ON ops_alert(project_id,updated_at) WHERE open_delivered_at IS NULL OR (state='resolved' AND resolved_delivered_at IS NULL);
