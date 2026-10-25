-- A reopened Task can close a later revision while each accepted closure remains immutable.
CREATE UNIQUE INDEX task_closure_revision_once_idx
  ON task_closure(project_id,task_id,task_revision_id);
DROP INDEX task_closure_once_idx;
