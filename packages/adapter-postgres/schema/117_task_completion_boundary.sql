-- Task completion boundary (Task b5993311, design 5fc0d476 item 5): when a Task may close. `delivered` is the behaviour before this column (a passed, used
-- Delivery is enough); `merged` also needs the PR the Delivery names to be merged into the main line as the repository shows. NULL: the Task was made before
-- the column existed and closes as `delivered`. An optional column, so no existing row changes.
ALTER TABLE task_proposal ADD COLUMN completion_boundary text CHECK (completion_boundary IS NULL OR completion_boundary IN ('delivered','merged'));
