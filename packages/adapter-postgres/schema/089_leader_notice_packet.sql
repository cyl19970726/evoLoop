-- Leader notice packets (DEC-045 W1): several pending notices travel to the Leader in one message, each with its own state.
-- Whether a new notice goes by packet follows a per-project switch (private configuration `leaderResultNotices.packets`, default off).
-- The coordinator copies the switch into leader_notice_packet_mode each cycle; with no row or enabled=false a new notice keeps the
-- one-notice-one-message path exactly as before. Notices that already exist keep the path they were created on.
ALTER TABLE leader_result_notice ADD COLUMN via_packet boolean NOT NULL DEFAULT false;
CREATE TABLE leader_notice_packet_mode (
  project_id uuid PRIMARY KEY, enabled boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION leader_result_notice_via_packet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A recovery replacement of a legacy notice keeps the one-notice-one-message path it was recovered on.
  NEW.via_packet := NEW.recovery_parent_notice_id IS NULL AND COALESCE((SELECT m.enabled FROM leader_notice_packet_mode m WHERE m.project_id=NEW.project_id), false);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_via_packet BEFORE INSERT ON leader_result_notice
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_via_packet();

CREATE TABLE leader_notice_packet (
  project_id uuid NOT NULL, packet_id uuid NOT NULL, session_id uuid NOT NULL,
  item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 20),
  byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 8192),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  content text NOT NULL,                           -- the exact message text, kept so a lost post can be repeated unchanged
  message_id uuid NOT NULL, message_operation_id uuid NOT NULL,   -- the ids the first post uses (the attempt row is written once the message exists)
  -- building: rows exist, the message is not posted yet; sent: posted; delivered: the Turn that reads it started;
  -- seen: that Turn ended normally; blocked: it failed behind a closed recovery gate (items held until recover);
  -- unknown: the outcome is not settled (read only, never resent); returned: items go to the next packet; withdrawn: never read.
  state text NOT NULL CHECK(state IN ('building','sent','delivered','seen','blocked','unknown','returned','withdrawn','recovered')),
  created_at timestamptz NOT NULL, sent_at timestamptz, delivered_at timestamptz, ended_at timestamptz,
  PRIMARY KEY(project_id,packet_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE INDEX leader_notice_packet_open ON leader_notice_packet(project_id,session_id,created_at) WHERE state IN ('building','sent','delivered','unknown');

-- One row per delivery attempt: a new Turn (a message) or, for W2, an input into a running Turn (a ledger row). Exactly one of the two ids.
CREATE TABLE leader_notice_packet_attempt (
  project_id uuid NOT NULL, packet_id uuid NOT NULL, attempt integer NOT NULL CHECK(attempt>0),
  method text NOT NULL CHECK(method IN ('new_turn','steer')),
  operation_id uuid NOT NULL, message_id uuid, direct_input_id uuid, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,packet_id,attempt), UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,packet_id) REFERENCES leader_notice_packet(project_id,packet_id),
  FOREIGN KEY(project_id,message_id) REFERENCES session_message(project_id,message_id),
  FOREIGN KEY(project_id,direct_input_id) REFERENCES session_direct_input(project_id,input_id),
  CHECK((message_id IS NULL) <> (direct_input_id IS NULL)),
  CHECK((method='new_turn') = (message_id IS NOT NULL))
);
CREATE UNIQUE INDEX leader_notice_packet_attempt_message ON leader_notice_packet_attempt(project_id,message_id) WHERE message_id IS NOT NULL;

CREATE TABLE leader_notice_packet_item (
  project_id uuid NOT NULL, packet_id uuid NOT NULL, notice_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
  -- pending (to send) -> delivered -> seen -> handled; withdrawn (stale before it was read); unknown (the packet's Turn did not settle it).
  state text NOT NULL CHECK(state IN ('pending','delivered','seen','handled','withdrawn','unknown')),
  read_before boolean NOT NULL DEFAULT false,      -- an earlier Turn may already have read it
  requeue boolean NOT NULL DEFAULT false,          -- unknown item that goes to the next packet
  disposition text CHECK(disposition IN ('handled','deferred')), defer_until timestamptz,
  handled_by text, handled_reason text, withdrawn_reason text,
  expected_turn_id text, actual_turn_id text, evidence text,
  last_operation_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,packet_id,notice_id),
  FOREIGN KEY(project_id,packet_id) REFERENCES leader_notice_packet(project_id,packet_id),
  FOREIGN KEY(project_id,notice_id) REFERENCES leader_result_notice(project_id,notice_id),
  CHECK(state<>'handled' OR disposition IS NOT NULL), CHECK(disposition IS DISTINCT FROM 'deferred' OR defer_until IS NOT NULL),
  CHECK(state<>'withdrawn' OR withdrawn_reason IS NOT NULL)
);
-- A notice sits in at most one packet that is still on its way or waiting to be handled.
CREATE UNIQUE INDEX leader_notice_packet_item_live ON leader_notice_packet_item(project_id,notice_id) WHERE state IN ('pending','delivered','seen');
CREATE INDEX leader_notice_packet_item_notice ON leader_notice_packet_item(project_id,notice_id,created_at);
