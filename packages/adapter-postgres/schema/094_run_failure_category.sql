-- A Task Run that fails on the model provider's account (quota or authentication) pauses the provider like a message does, and the
-- gate that failure closes is released with the hold. The category the adapter reported is kept on the Run, as it is on a message's processing.
ALTER TABLE runtime_run ADD COLUMN failure_category text;
