-- Extend the immutable reference decision vocabulary without rewriting existing Git/Wiki facts.
ALTER TABLE task_external_ref_decision
  DROP CONSTRAINT task_external_ref_decision_source_kind_check;
ALTER TABLE task_external_ref_decision
  ADD CONSTRAINT task_external_ref_decision_source_kind_check
  CHECK (source_kind IN ('git','wiki','run'));
