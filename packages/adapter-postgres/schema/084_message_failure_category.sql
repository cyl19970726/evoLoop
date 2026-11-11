-- The native error class of a failed message Turn, kept next to its summary so every reader can say why work stopped.
ALTER TABLE session_message_processing ADD COLUMN failure_category text;
