-- S1 Markdown rows remain readable; new revisions may store one canonical external payload.
ALTER TABLE document_revision ALTER COLUMN body DROP NOT NULL;
ALTER TABLE document_revision DROP CONSTRAINT document_revision_format_check;
ALTER TABLE document_revision ADD CONSTRAINT document_revision_format_check CHECK (format IN ('markdown', 'html'));
ALTER TABLE document_revision ADD COLUMN media_type text NOT NULL DEFAULT 'text/markdown';
ALTER TABLE document_revision ADD COLUMN original_name text;
ALTER TABLE document_revision ADD COLUMN payload_ref uuid;
ALTER TABLE document_revision ADD COLUMN entrypoint text;
ALTER TABLE document_revision ADD COLUMN assets_manifest jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE document_revision ADD CONSTRAINT document_revision_original_name CHECK (original_name IS NULL OR (length(original_name) BETWEEN 1 AND 240 AND original_name !~ '[/\\]'));
ALTER TABLE document_revision ADD CONSTRAINT document_revision_payload_xor CHECK ((body IS NOT NULL) <> (payload_ref IS NOT NULL));
ALTER TABLE document_revision ADD CONSTRAINT document_revision_media_type CHECK (
  (format='markdown' AND media_type='text/markdown') OR (format='html' AND media_type='text/html'));
ALTER TABLE document_revision ADD CONSTRAINT document_revision_manifest_array CHECK (jsonb_typeof(assets_manifest)='array');
ALTER TABLE document_revision ADD CONSTRAINT document_revision_entrypoint CHECK (entrypoint IS NULL OR (format='html' AND payload_ref IS NOT NULL));
CREATE UNIQUE INDEX document_revision_payload_unique ON document_revision(project_id, payload_ref) WHERE payload_ref IS NOT NULL;

CREATE TABLE document_blob_ref (
  project_id uuid NOT NULL,
  blob_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('main','asset')),
  relative_path text,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0 AND byte_size <= 16777216),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  registered_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, blob_id),
  UNIQUE (project_id, blob_id, document_id, revision_id),
  FOREIGN KEY (project_id, document_id, revision_id)
    REFERENCES document_revision(project_id, document_id, revision_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((role='main' AND relative_path IS NULL) OR
         (role='asset' AND relative_path IS NOT NULL AND relative_path <> '' AND relative_path !~ '(^|/)\.\.?(/|$)' AND relative_path !~ '(^/|\\)'))
);
CREATE UNIQUE INDEX document_blob_one_main ON document_blob_ref(project_id, document_id, revision_id) WHERE role='main';
CREATE UNIQUE INDEX document_blob_asset_path ON document_blob_ref(project_id, document_id, revision_id, relative_path) WHERE role='asset';
CREATE TRIGGER immutable_document_blob_ref BEFORE UPDATE OR DELETE ON document_blob_ref FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
ALTER TABLE document_revision ADD CONSTRAINT document_revision_payload_owner_fk
  FOREIGN KEY (project_id, payload_ref, document_id, revision_id)
  REFERENCES document_blob_ref(project_id, blob_id, document_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION check_document_payload_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE missing_count integer;
BEGIN
  IF NEW.payload_ref IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM document_blob_ref b WHERE b.project_id=NEW.project_id AND b.blob_id=NEW.payload_ref
      AND b.document_id=NEW.document_id AND b.revision_id=NEW.revision_id AND b.role='main'
      AND b.content_hash=NEW.content_hash AND b.media_type=NEW.media_type
    ) THEN RAISE EXCEPTION 'document main payload is not registered or does not match'; END IF;
  ELSIF NEW.assets_manifest <> '[]'::jsonb THEN
    RAISE EXCEPTION 'inline document cannot have external assets';
  END IF;
  SELECT count(*) INTO missing_count FROM jsonb_array_elements(NEW.assets_manifest) a
    WHERE NOT EXISTS (
      SELECT 1 FROM document_blob_ref b WHERE b.project_id=NEW.project_id
      AND b.document_id=NEW.document_id AND b.revision_id=NEW.revision_id AND b.role='asset'
      AND b.blob_id::text=a->>'blobId' AND b.relative_path=a->>'path'
      AND b.content_hash=a->>'contentHash' AND b.byte_size::text=a->>'size'
      AND b.media_type=a->>'mediaType'
    );
  IF missing_count > 0 THEN RAISE EXCEPTION 'document asset manifest has missing or mismatched resources'; END IF;
  IF (SELECT count(*) FROM document_blob_ref b WHERE b.project_id=NEW.project_id AND b.document_id=NEW.document_id
      AND b.revision_id=NEW.revision_id AND b.role='asset') <> jsonb_array_length(NEW.assets_manifest)
  THEN RAISE EXCEPTION 'document asset registry differs from manifest'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER document_payload_complete AFTER INSERT ON document_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_document_payload_complete();

-- Git formal documents have independent source identity. No process_document row or body copy.
CREATE TABLE git_source_ref (
  project_id uuid NOT NULL REFERENCES project(project_id),
  git_source_ref_id uuid NOT NULL,
  repository_id text NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 240),
  source_path text NOT NULL CHECK (length(source_path) BETWEEN 1 AND 1024 AND source_path !~ '(^/|\\)' AND source_path !~ '(^|/)\.\.?(/|$)'),
  commit_hash text NOT NULL CHECK (commit_hash ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('reachable','unavailable','withdrawn')),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, git_source_ref_id),
  UNIQUE (project_id, repository_id, source_path, commit_hash, content_hash)
);
CREATE TRIGGER immutable_git_source_ref BEFORE UPDATE OR DELETE ON git_source_ref FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
