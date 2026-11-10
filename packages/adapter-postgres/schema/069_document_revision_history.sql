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
-- Each recursion step looks up the children of the rows the previous step found, but the step is
-- planned once from the number of roots: with many documents the planner picks a hash or merge join
-- that rereads the whole table on every step, so long chains cost (depth x table). A temporary
-- (project_id, document_id, previous_revision_id) index and nested loops for this one statement make
-- every step an index probe; the index is dropped again, so the final schema is unchanged. Results
-- go to analyzed temporary tables so the numbering UPDATE is planned on real row counts. On 49,000
-- revisions (5,000 x 8 plus 3 x 3,000) the migration went from about 21 s to about 1 s; on one
-- 20,000-revision chain from about 36 s to under 1 s.
CREATE INDEX document_revision_backfill_previous ON document_revision(project_id, document_id, previous_revision_id);
ANALYZE document_revision;
SET LOCAL enable_hashjoin = off;
SET LOCAL enable_mergejoin = off;
CREATE TEMPORARY TABLE document_revision_chain ON COMMIT DROP AS
WITH RECURSIVE chain AS (
  SELECT project_id, document_id, revision_id, 1 AS position
  FROM document_revision WHERE previous_revision_id IS NULL
  UNION ALL
  SELECT r.project_id, r.document_id, r.revision_id, chain.position + 1
  FROM chain JOIN document_revision r ON r.project_id=chain.project_id AND r.document_id=chain.document_id
    AND r.previous_revision_id=chain.revision_id
) SELECT project_id, document_id, revision_id, position FROM chain;
RESET enable_hashjoin;
RESET enable_mergejoin;
DROP INDEX document_revision_backfill_previous;
ANALYZE document_revision_chain;
-- One root, every revision reached from it, and no two revisions at the same depth (no fork). One
-- grouped pass over the table, so no join between two aggregates whose sizes the planner cannot see.
CREATE TEMPORARY TABLE document_revision_linear ON COMMIT DROP AS
SELECT r.project_id, r.document_id
FROM document_revision r LEFT JOIN document_revision_chain chain ON chain.project_id=r.project_id
  AND chain.document_id=r.document_id AND chain.revision_id=r.revision_id
GROUP BY r.project_id, r.document_id
HAVING count(*) FILTER (WHERE r.previous_revision_id IS NULL) = 1
  AND count(chain.revision_id) = count(*) AND count(DISTINCT chain.position) = count(*);
ANALYZE document_revision_linear;
UPDATE document_revision r SET revision_number = chain.position
FROM document_revision_chain chain JOIN document_revision_linear USING (project_id, document_id)
WHERE r.project_id=chain.project_id AND r.document_id=chain.document_id AND r.revision_id=chain.revision_id;

-- A fork, a second root or a broken chain cannot come from the current writers; if older data has
-- one, number that whole document by creation time and revision ID instead. migrate() discards this
-- notice; the release steps in docs/architecture/deployment.md run the same check beforehand.
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
  FROM document_revision d WHERE NOT EXISTS (SELECT 1 FROM document_revision_linear l
    WHERE l.project_id=d.project_id AND l.document_id=d.document_id)) ordered
WHERE r.project_id=ordered.project_id AND r.document_id=ordered.document_id AND r.revision_id=ordered.revision_id;

ALTER TABLE document_revision ENABLE TRIGGER immutable_document_revision,
  ENABLE TRIGGER document_revision_allocation_observation;
ALTER TABLE document_revision ALTER COLUMN revision_number SET NOT NULL,
  ADD CONSTRAINT document_revision_number_positive CHECK (revision_number > 0),
  -- Also the index behind the newest-first page, its cursor and the per-document maximum.
  ADD CONSTRAINT document_revision_number_unique UNIQUE (project_id, document_id, revision_number);

-- New revisions take the next number of their document whoever inserts them (core commands and
-- the direct SQL writers in scheduling and task timing alike). A supplied number is refused rather
-- than replaced, so a row-by-row import of history (DEC-041) cannot silently lose the source host's
-- numbering. A full pg_dump/pg_restore is unaffected: triggers are created in the post-data section,
-- after the table data is loaded. Locking the document row serializes appends to one document even
-- outside the project advisory lock, so the maximum read here is the committed one; NO KEY UPDATE
-- leaves foreign-key checks unblocked. Numbers stay 1..N without gaps: a rolled-back insert never
-- commits and revisions cannot be deleted.
CREATE FUNCTION assign_document_revision_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision_number IS NOT NULL THEN
    RAISE EXCEPTION 'document_revision.revision_number is assigned by storage; omit it (got %)', NEW.revision_number
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM process_document WHERE project_id=NEW.project_id AND document_id=NEW.document_id FOR NO KEY UPDATE;
  SELECT coalesce(max(revision_number), 0) + 1 INTO NEW.revision_number FROM document_revision
    WHERE project_id=NEW.project_id AND document_id=NEW.document_id;
  RETURN NEW;
END $$;
CREATE TRIGGER document_revision_number BEFORE INSERT ON document_revision
  FOR EACH ROW EXECUTE FUNCTION assign_document_revision_number();
