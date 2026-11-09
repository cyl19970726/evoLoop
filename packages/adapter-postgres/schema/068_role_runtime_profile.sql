-- Which runtime a Role runs on and which skills its Sessions load. Revision 1 binds the Role to one
-- runtime for good (a Codex Thread and a Claude session are different native objects, and a Role's
-- history should not straddle them); later revisions only change the skill selection. Append only.
CREATE FUNCTION role_skill_selection_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  key text;
  item jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  FOR key IN SELECT jsonb_object_keys(value) LOOP
    IF key NOT IN ('project','personal','builtin','add','remove') THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(value->'project') IS DISTINCT FROM 'boolean' OR jsonb_typeof(value->'personal') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(value->'builtin') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(value->'add') IS DISTINCT FROM 'array' OR jsonb_typeof(value->'remove') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(value->'add') > 32 OR jsonb_array_length(value->'remove') > 32 THEN RETURN false; END IF;
  FOR item IN SELECT jsonb_array_elements(value->'add') UNION ALL SELECT jsonb_array_elements(value->'remove') LOOP
    IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE role_runtime_revision (
  project_id uuid NOT NULL,
  role_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  runtime_provider text NOT NULL CHECK (runtime_provider IN ('codex','claude')),
  skills jsonb NOT NULL CHECK (role_skill_selection_valid(skills)),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 240),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  -- NULL only for the rows this migration derives from existing Sessions.
  operation_id uuid,
  created_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id, role_id, revision),
  FOREIGN KEY (project_id, role_id) REFERENCES role_definition(project_id, role_id)
);
CREATE UNIQUE INDEX role_runtime_revision_operation ON role_runtime_revision(project_id, operation_id) WHERE operation_id IS NOT NULL;

-- One lock per Role serialises its first binding against Session reservation for the same Role.
CREATE FUNCTION lock_role_runtime(project uuid, role text) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('role_runtime:' || project::text || ':' || role, 0));
$$;

CREATE FUNCTION validate_role_runtime_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest integer;
  bound text;
BEGIN
  PERFORM lock_role_runtime(NEW.project_id, NEW.role_id::text);
  SELECT max(revision) INTO latest FROM role_runtime_revision WHERE project_id=NEW.project_id AND role_id=NEW.role_id;
  IF NEW.revision <> coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'role runtime revision must follow the latest revision' USING ERRCODE='23514';
  END IF;
  IF latest IS NOT NULL THEN
    SELECT runtime_provider INTO bound FROM role_runtime_revision WHERE project_id=NEW.project_id AND role_id=NEW.role_id AND revision=1;
    IF NEW.runtime_provider <> bound THEN
      RAISE EXCEPTION 'role runtime is bound and cannot change' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM runtime_session WHERE project_id=NEW.project_id AND lower(role_id)=NEW.role_id::text
      AND state <> 'closed' AND runtime_provider <> NEW.runtime_provider) THEN
    RAISE EXCEPTION 'role has open Sessions on another runtime' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_runtime_revision_validate BEFORE INSERT ON role_runtime_revision
  FOR EACH ROW EXECUTE FUNCTION validate_role_runtime_revision();
CREATE TRIGGER role_runtime_revision_immutable BEFORE UPDATE OR DELETE ON role_runtime_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

-- Existing Roles that already ran Sessions are bound to the runtime those Sessions use, preferring an
-- open Session's. A Role whose open Sessions span both runtimes stays unbound until one side is closed.
INSERT INTO role_runtime_revision(project_id, role_id, revision, runtime_provider, skills, actor_id, reason, operation_id, created_at_utc)
SELECT d.project_id, d.role_id, 1, chosen.runtime_provider,
  '{"project":true,"personal":false,"builtin":true,"add":[],"remove":[]}'::jsonb,
  'system:migration-068', '迁移时按已有 Session 的运行时绑定', NULL, now()
FROM role_definition d
CROSS JOIN LATERAL (
  SELECT s.runtime_provider FROM runtime_session s
  WHERE s.project_id=d.project_id AND lower(s.role_id)=d.role_id::text
  ORDER BY (s.state <> 'closed') DESC, s.created_at DESC, s.session_id DESC LIMIT 1
) chosen
WHERE (SELECT count(DISTINCT s.runtime_provider) FROM runtime_session s
  WHERE s.project_id=d.project_id AND lower(s.role_id)=d.role_id::text AND s.state <> 'closed') <= 1;

-- A Session of a bound Role must use the Role's runtime. Sessions of unbound Roles and of owners that
-- are not Roles are unaffected.
CREATE FUNCTION enforce_role_runtime_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound text;
BEGIN
  IF NEW.role_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  PERFORM lock_role_runtime(NEW.project_id, lower(NEW.role_id));
  SELECT runtime_provider INTO bound FROM role_runtime_revision
    WHERE project_id=NEW.project_id AND role_id=NEW.role_id::uuid AND revision=1;
  IF bound IS NOT NULL AND bound <> NEW.runtime_provider THEN
    RAISE EXCEPTION 'session runtime differs from the role binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_role_runtime BEFORE INSERT ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION enforce_role_runtime_binding();
