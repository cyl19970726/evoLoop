-- Per-document revision sequence for the revision history (GET .../documents/:id/revisions) and the
-- "revision N of M" shown for one fixed revision. Order and numbers never depend on wall-clock
-- created_at, so equal timestamps or a clock stepped back cannot reorder or renumber revisions.
ALTER TABLE document_revision ADD COLUMN revision_number integer;

-- Backfill existing history without recording it as a business change: revision rows are otherwise
-- immutable, and the observation journal must not see a burst of synthetic updates.
ALTER TABLE document_revision DISABLE TRIGGER immutable_document_revision,
  DISABLE TRIGGER document_revision_allocation_observation;

-- Every writer appends after the current head (previous_revision_id = current head under a version
-- CAS), so a document's revisions normally form one chain from one root; number them along it.
WITH RECURSIVE chain AS (
  SELECT project_id, document_id, revision_id, 1 AS position
  FROM document_revision WHERE previous_revision_id IS NULL
  UNION ALL
  SELECT r.project_id, r.document_id, r.revision_id, chain.position + 1
  FROM chain JOIN document_revision r ON r.project_id=chain.project_id AND r.document_id=chain.document_id
    AND r.previous_revision_id=chain.revision_id
), totals AS (
  SELECT project_id, document_id, count(*) AS revisions,
    count(*) FILTER (WHERE previous_revision_id IS NULL) AS roots
  FROM document_revision GROUP BY project_id, document_id
), reached AS (
  SELECT project_id, document_id, count(*) AS reached, count(DISTINCT position) AS positions
  FROM chain GROUP BY project_id, document_id
), linear AS (
  -- One root, every revision reached from it, and no two revisions at the same depth (no fork).
  SELECT totals.project_id, totals.document_id FROM totals JOIN reached USING (project_id, document_id)
  WHERE totals.roots = 1 AND reached.reached = totals.revisions AND reached.positions = totals.revisions
)
UPDATE document_revision r SET revision_number = chain.position
FROM chain JOIN linear USING (project_id, document_id)
WHERE r.project_id=chain.project_id AND r.document_id=chain.document_id AND r.revision_id=chain.revision_id;

-- A fork, a second root or a broken chain cannot come from the current writers; if older data has
-- one, number that whole document by creation time and revision ID instead.
DO $$
DECLARE fallback integer;
BEGIN
  SELECT count(DISTINCT (project_id, document_id)) INTO fallback FROM document_revision WHERE revision_number IS NULL;
  IF fallback > 0 THEN
    RAISE NOTICE '069: % document(s) are not one revision chain; numbered by created_at, revision_id', fallback;
  END IF;
END $$;
UPDATE document_revision r SET revision_number = ordered.position
FROM (SELECT project_id, document_id, revision_id,
    row_number() OVER (PARTITION BY project_id, document_id ORDER BY created_at, revision_id) AS position
  FROM document_revision) ordered
WHERE r.revision_number IS NULL AND r.project_id=ordered.project_id AND r.document_id=ordered.document_id
  AND r.revision_id=ordered.revision_id;

ALTER TABLE document_revision ENABLE TRIGGER immutable_document_revision,
  ENABLE TRIGGER document_revision_allocation_observation;
ALTER TABLE document_revision ALTER COLUMN revision_number SET NOT NULL,
  ADD CONSTRAINT document_revision_number_positive CHECK (revision_number > 0),
  -- Also the index behind the newest-first page, its cursor and the per-document maximum.
  ADD CONSTRAINT document_revision_number_unique UNIQUE (project_id, document_id, revision_number);

-- New revisions take the next number of their document whoever inserts them (core commands and
-- the direct SQL writers in scheduling and task timing alike); a supplied value is ignored. Locking
-- the document row serializes appends to one document even outside the project advisory lock, so
-- the maximum read here is the committed one; NO KEY UPDATE leaves foreign-key checks unblocked.
-- Numbers stay 1..N without gaps: a rolled-back insert never commits and revisions cannot be deleted.
CREATE FUNCTION assign_document_revision_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM process_document WHERE project_id=NEW.project_id AND document_id=NEW.document_id FOR NO KEY UPDATE;
  SELECT coalesce(max(revision_number), 0) + 1 INTO NEW.revision_number FROM document_revision
    WHERE project_id=NEW.project_id AND document_id=NEW.document_id;
  RETURN NEW;
END $$;
CREATE TRIGGER document_revision_number BEFORE INSERT ON document_revision
  FOR EACH ROW EXECUTE FUNCTION assign_document_revision_number();
