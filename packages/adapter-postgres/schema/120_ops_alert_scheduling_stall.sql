-- A scheduling stall (state=error, or the scheduler's last tick too old) is its own alert kind (Task 70da6d67): one open alert per project, opened when the
-- alert pump sees it and resolved when the scheduler is healthy again. Only the kind check and a unique index change; no row is touched.
ALTER TABLE ops_alert DROP CONSTRAINT IF EXISTS ops_alert_kind_check;
ALTER TABLE ops_alert ADD CONSTRAINT ops_alert_kind_check CHECK(kind IN ('provider_hold','stall','scheduling_stall'));
CREATE UNIQUE INDEX IF NOT EXISTS ops_alert_open_scheduling_stall ON ops_alert(project_id) WHERE kind='scheduling_stall' AND state='open';
