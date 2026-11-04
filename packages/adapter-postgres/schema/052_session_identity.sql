-- Session visual identity is part of the existing profile authority. Null metadata
-- means no name/team classification has yet been set by a reviewer.
ALTER TABLE session_profile ALTER COLUMN display_name DROP NOT NULL;
ALTER TABLE session_profile ALTER COLUMN purpose DROP NOT NULL;
ALTER TABLE session_profile ALTER COLUMN membership DROP NOT NULL;
ALTER TABLE session_profile ALTER COLUMN tenure DROP NOT NULL;
ALTER TABLE session_profile ADD COLUMN identity_color text
  CHECK (identity_color IN ('violet','copper','blue','teal','magenta','olive','coral','plum'));
ALTER TABLE session_profile ADD COLUMN identity_mark text
  CHECK (identity_mark IN ('diamond','dot','layers','brackets','spark','grid','check','code'));
ALTER TABLE session_profile_revision ALTER COLUMN display_name DROP NOT NULL;
ALTER TABLE session_profile_revision ALTER COLUMN purpose DROP NOT NULL;
ALTER TABLE session_profile_revision ALTER COLUMN membership DROP NOT NULL;
ALTER TABLE session_profile_revision ALTER COLUMN tenure DROP NOT NULL;
ALTER TABLE session_profile_revision ADD COLUMN identity_color text
  CHECK (identity_color IN ('violet','copper','blue','teal','magenta','olive','coral','plum'));
ALTER TABLE session_profile_revision ADD COLUMN identity_mark text
  CHECK (identity_mark IN ('diamond','dot','layers','brackets','spark','grid','check','code'));

-- The originating runtime/HostLink event already invalidates a newly created
-- Session. Avoid a second empty profile event; later identity edits are visible.
DROP TRIGGER session_profile_observation ON session_profile;
CREATE TRIGGER session_profile_observation AFTER INSERT OR UPDATE ON session_profile
  FOR EACH ROW WHEN (NEW.version>1 OR NEW.display_name IS NOT NULL OR NEW.membership IS NOT NULL)
  EXECUTE FUNCTION record_session_observation_change();


-- Assign current managed Sessions first. A profile row created only for identity
-- does not claim a display name, purpose, membership, or tenure.
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
INSERT INTO session_profile(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,
  actor_id,reason,updated_at,identity_color,identity_mark)
SELECT project_id,target_kind,target_id,1,NULL,NULL,NULL,NULL,
  'system:session-identity','Stable identity migration',now(),
  (ARRAY['violet','copper','blue','teal','magenta','olive','coral','plum'])[slot+1],
  (ARRAY['diamond','dot','layers','brackets','spark','grid','check','code'])[slot+1]
FROM numbered ON CONFLICT DO NOTHING;

-- Existing profile metadata and versions are retained; only the new columns
-- receive the same ordered default that missing profiles received above.
WITH targets_base AS (
  SELECT project_id,'owned'::text AS target_kind,session_id AS target_id,
    CASE WHEN state='ready' THEN 0 ELSE 1 END AS priority FROM runtime_session
  UNION ALL
  SELECT l.project_id,'external',l.link_id,2 FROM role_host_link l
  JOIN role_host_link_revision r ON r.project_id=l.project_id AND r.link_id=l.link_id AND r.version=l.version
  WHERE r.host->>'kind'='external'
), targets AS (
  SELECT * FROM targets_base
  UNION ALL
  SELECT p.project_id,p.target_kind,p.target_id,3 FROM session_profile p
  WHERE NOT EXISTS (SELECT 1 FROM targets_base t WHERE t.project_id=p.project_id
    AND t.target_kind=p.target_kind AND t.target_id=p.target_id)
), numbered AS (
  SELECT *, (row_number() OVER (PARTITION BY project_id ORDER BY priority,target_id)-1)%8 AS slot FROM targets
)
UPDATE session_profile p SET
  version=p.version+1,actor_id='system:session-identity',reason='Stable identity migration',updated_at=now(),
  identity_color=(ARRAY['violet','copper','blue','teal','magenta','olive','coral','plum'])[n.slot+1],
  identity_mark=(ARRAY['diamond','dot','layers','brackets','spark','grid','check','code'])[n.slot+1]
FROM numbered n WHERE p.project_id=n.project_id AND p.target_kind=n.target_kind AND p.target_id=n.target_id
  AND p.identity_color IS NULL;

INSERT INTO session_profile_revision(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,
  actor_id,reason,updated_at,identity_color,identity_mark)
SELECT p.project_id,p.target_kind,p.target_id,p.version,p.display_name,p.purpose,p.membership,p.tenure,
  p.actor_id,p.reason,p.updated_at,p.identity_color,p.identity_mark
FROM session_profile p WHERE p.actor_id='system:session-identity' AND p.reason='Stable identity migration'
ON CONFLICT DO NOTHING;

ALTER TABLE session_profile ALTER COLUMN identity_color SET NOT NULL;
ALTER TABLE session_profile ALTER COLUMN identity_mark SET NOT NULL;

CREATE FUNCTION assign_session_profile_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project uuid; kind text; target uuid; selected integer;
BEGIN
  project:=NEW.project_id;
  IF TG_TABLE_NAME='runtime_session' THEN kind:='owned'; target:=NEW.session_id;
  ELSIF NEW.host->>'kind'='external' THEN kind:='external'; target:=NEW.link_id;
  ELSE RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(project::text, 527));
  SELECT slot INTO selected FROM generate_series(1,8) AS slot
    LEFT JOIN session_profile p ON p.project_id=project AND p.identity_color=
      (ARRAY['violet','copper','blue','teal','magenta','olive','coral','plum'])[slot]
    GROUP BY slot ORDER BY count(p.target_id),slot LIMIT 1;
  INSERT INTO session_profile(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,
    actor_id,reason,updated_at,identity_color,identity_mark)
  VALUES(project,kind,target,1,NULL,NULL,NULL,NULL,'system:session-identity','Session created',now(),
    (ARRAY['violet','copper','blue','teal','magenta','olive','coral','plum'])[selected],
    (ARRAY['diamond','dot','layers','brackets','spark','grid','check','code'])[selected]) ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO session_profile_revision SELECT * FROM session_profile
      WHERE project_id=project AND target_kind=kind AND target_id=target;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_visual_identity AFTER INSERT ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION assign_session_profile_identity();
CREATE TRIGGER external_session_visual_identity AFTER INSERT OR UPDATE ON role_host_link_revision
  FOR EACH ROW EXECUTE FUNCTION assign_session_profile_identity();
