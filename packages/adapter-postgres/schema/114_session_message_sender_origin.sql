-- A Hub-signed sender is recognised only at the moment its request arrives (Principal.origin). The dispatcher runs later and could not tell: it asked the local
-- identity file, which has no Hub account, so a message that was allowed at send time (and shown as sendable) stayed queued with MESSAGE_GRANT_MISSING (Task db48f6cd).
-- The verified origin is now stored with the message and never changes. NULL means "this machine's own identity", which is also what every message stored before this
-- migration was, so existing rows keep their exact old behaviour; nothing is inferred from an actor ID and nothing is backfilled. Rolling back: stop the service, drop the
-- trigger and the column (data in it is only 'hub' markers).
ALTER TABLE session_message ADD COLUMN sender_origin text CHECK(sender_origin IS NULL OR sender_origin='hub');
CREATE FUNCTION protect_session_message_sender_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender_origin IS DISTINCT FROM OLD.sender_origin THEN RAISE EXCEPTION 'message sender origin is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_message_sender_origin_immutable BEFORE UPDATE ON session_message FOR EACH ROW EXECUTE FUNCTION protect_session_message_sender_origin();
