-- Newest-first revision history of one document (GET .../documents/:id/revisions).
-- The primary key (project_id, document_id, revision_id) narrows to one document but not in
-- creation order, so a page would sort every revision of that document first. This index serves
-- the keyset page (scanned backward) and the per-document counts as index range scans.
CREATE INDEX document_revision_history_idx ON document_revision(project_id, document_id, created_at, revision_id);
