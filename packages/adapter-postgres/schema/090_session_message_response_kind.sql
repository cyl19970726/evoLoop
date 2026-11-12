-- Native reply text and the bounded-read system note are different sources even though both are
-- persisted in response for audit. External Connector delivery may send only native reply text.
ALTER TABLE session_message_processing ADD COLUMN response_kind text NOT NULL DEFAULT 'native'
  CHECK(response_kind IN ('native','bounded_unread'));
-- #362 already persisted its machine-generated note before this source marker existed. This one-time
-- exact full-string match only backfills those rows; outbound delivery never classifies text at runtime.
ALTER TABLE session_message_processing DISABLE TRIGGER session_message_processing_identity,
  DISABLE TRIGGER session_message_processing_observation;
UPDATE session_message_processing SET response_kind='bounded_unread'
WHERE response ~ '^（本轮已结束，但它的原生记录超过 [0-9]+ 页，回复没有在有界读取内读出；完整回复见该 Session 的原生会话记录。）$';
ALTER TABLE session_message_processing ENABLE TRIGGER session_message_processing_identity,
  ENABLE TRIGGER session_message_processing_observation;
ALTER TABLE session_message_processing
  ADD CONSTRAINT session_message_processing_bounded_unread_response
  CHECK(response_kind<>'bounded_unread' OR response IS NOT NULL);
