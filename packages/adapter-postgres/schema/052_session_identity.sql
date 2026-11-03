-- Identity is independent of activity, role and presentation classification.
CREATE TABLE session_identity (
  project_id uuid NOT NULL REFERENCES project(project_id),
  target_kind text NOT NULL CHECK (target_kind IN ('owned','external')),
  target_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  color text NOT NULL CHECK (color IN ('violet','copper','blue','teal','magenta','olive','coral','plum')),
  mark text NOT NULL CHECK (mark IN ('diamond','dot','layers','brackets','spark','grid','check','code')),
  actor_id text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id,target_kind,target_id)
);
CREATE TABLE session_identity_revision (LIKE session_identity INCLUDING CONSTRAINTS);
ALTER TABLE session_identity_revision ADD PRIMARY KEY (project_id,target_kind,target_id,version);
ALTER TABLE session_identity_revision ADD FOREIGN KEY (project_id,target_kind,target_id)
  REFERENCES session_identity(project_id,target_kind,target_id);
CREATE TRIGGER session_identity_revision_immutable BEFORE UPDATE OR DELETE ON session_identity_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE FUNCTION record_session_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.project_id<>OLD.project_id OR NEW.target_kind<>OLD.target_kind
    OR NEW.target_id<>OLD.target_id OR NEW.version<>OLD.version+1) THEN
    RAISE EXCEPTION 'Session identity origin/version cannot change' USING ERRCODE='23514';
  END IF;
  INSERT INTO session_identity_revision SELECT NEW.*;
  RETURN NEW;
END $$;
CREATE TRIGGER session_identity_revision_record AFTER INSERT OR UPDATE ON session_identity
  FOR EACH ROW EXECUTE FUNCTION record_session_identity_revision();

-- One fixed ordering gives existing Sessions distinct initial pairs in each project.
WITH targets AS (
  SELECT project_id,'owned'::text AS target_kind,session_id AS target_id,
    CASE WHEN state='ready' THEN 0 ELSE 1 END AS priority FROM runtime_session
  UNION ALL
  SELECT l.project_id,'external',l.link_id,2 FROM role_host_link l
  JOIN role_host_link_revision r ON r.project_id=l.project_id AND r.link_id=l.link_id AND r.version=l.version
  WHERE r.host->>'kind'='external'
), numbered AS (
  SELECT *, (row_number() OVER (PARTITION BY project_id ORDER BY priority,target_id)-1)%8 AS slot FROM targets
)
INSERT INTO session_identity(project_id,target_kind,target_id,version,color,mark,actor_id,reason,updated_at)
SELECT project_id,target_kind,target_id,1,
  (ARRAY['violet','copper','blue','teal','magenta','olive','coral','plum'])[slot+1],
  (ARRAY['diamond','dot','layers','brackets','spark','grid','check','code'])[slot+1],
  'system:session-identity','Stable identity migration',now() FROM numbered;

CREATE FUNCTION assign_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project uuid; kind text; target uuid; selected integer;
BEGIN
  project:=NEW.project_id;
  IF TG_TABLE_NAME='runtime_session' THEN kind:='owned'; target:=NEW.session_id;
  ELSIF NEW.host->>'kind'='external' THEN kind:='external'; target:=NEW.link_id;
  ELSE RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(project::text, 527));
  SELECT slot INTO selected FROM generate_series(1,8) AS slot
    LEFT JOIN session_identity i ON i.project_id=project AND i.color=
      (ARRAY['violet','copper','blue','teal','magenta','olive','coral','plum'])[slot]
    GROUP BY slot ORDER BY count(i.target_id),slot LIMIT 1;
  INSERT INTO session_identity(project_id,target_kind,target_id,version,color,mark,actor_id,reason,updated_at)
  VALUES(project,kind,target,1,
    (ARRAY['violet','copper','blue','teal','magenta','olive','coral','plum'])[selected],
    (ARRAY['diamond','dot','layers','brackets','spark','grid','check','code'])[selected],
    'system:session-identity','Session created',now()) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_visual_identity AFTER INSERT ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION assign_session_identity();
CREATE TRIGGER external_session_identity AFTER INSERT OR UPDATE ON role_host_link_revision
  FOR EACH ROW EXECUTE FUNCTION assign_session_identity();
CREATE FUNCTION record_session_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM append_session_observation_row('session_identity',to_jsonb(NEW)||jsonb_build_object(
    'link_id',NEW.target_id,'session_id',CASE WHEN NEW.target_kind='owned' THEN NEW.target_id END));
  RETURN NEW;
END $$;
CREATE TRIGGER session_identity_observation AFTER INSERT OR UPDATE ON session_identity
  FOR EACH ROW EXECUTE FUNCTION record_session_identity_change();
