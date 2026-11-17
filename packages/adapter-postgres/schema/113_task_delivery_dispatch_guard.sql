-- A failed or unused observation from the declared consumer is the only source of an internal rework entry.
ALTER TABLE session_line_entry
  ADD COLUMN rework_observation_id uuid,
  ADD COLUMN rework_delivery_id uuid;
ALTER TABLE session_line_entry DROP CONSTRAINT session_line_entry_source_check;
ALTER TABLE session_line_entry ADD CONSTRAINT session_line_entry_source_check
  CHECK(source IN ('leader','schedule','rework'));
ALTER TABLE session_line_entry ADD CONSTRAINT session_line_entry_rework_source_check
  CHECK((source='rework') = (rework_observation_id IS NOT NULL AND rework_delivery_id IS NOT NULL));
ALTER TABLE session_line_entry ADD CONSTRAINT session_line_entry_rework_observation_fk
  FOREIGN KEY(project_id,rework_observation_id) REFERENCES consumer_observation(project_id,observation_id);
ALTER TABLE session_line_entry ADD CONSTRAINT session_line_entry_rework_delivery_fk
  FOREIGN KEY(project_id,rework_delivery_id) REFERENCES delivery(project_id,delivery_id);
CREATE UNIQUE INDEX session_line_entry_rework_delivery
  ON session_line_entry(project_id,rework_delivery_id) WHERE source='rework';
