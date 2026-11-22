-- Rolling back migration 118 is a later FORWARD migration (the project's migrations are down=false): copy this file's statements into the next numbered
-- schema/NNN_*.sql with a migrations/NNN_*.mjs wrapper. It touches only the four tables 118 created; project_stage, stage_revision, stage_review,
-- stage_phase_key and every Task table keep all rows. Deploy the previous release's code first (it never reads these tables), then run it.
DROP TABLE task_stage_history;
DROP TABLE task_stage;
DROP TABLE stage_milestone_history;
DROP TABLE stage_milestone;
