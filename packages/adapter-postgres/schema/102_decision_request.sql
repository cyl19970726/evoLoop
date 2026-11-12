-- 待我决定 (DEC-045 inbox): a structured, queryable request for a named identity to decide something. It replaces "the Leader said so in
-- the conversation": the request has a question, optional options, who asked, who is asked, and the answer once given.
CREATE TABLE decision_request (
  project_id uuid NOT NULL, request_id uuid NOT NULL,
  requested_by text NOT NULL CHECK(length(btrim(requested_by)) BETWEEN 1 AND 240),
  requested_from text NOT NULL CHECK(length(btrim(requested_from)) BETWEEN 1 AND 240),
  task_id uuid, subject text NOT NULL CHECK(length(btrim(subject)) BETWEEN 1 AND 240),
  question text NOT NULL CHECK(length(btrim(question)) BETWEEN 1 AND 4000),
  options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(options)='array' AND jsonb_array_length(options)<=10),
  state text NOT NULL CHECK(state IN ('open','answered','withdrawn')),
  answer text, answer_reason text, answered_by text, answered_at timestamptz,
  withdrawn_reason text, version integer NOT NULL CHECK(version>0),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,request_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id),
  CHECK(state<>'answered' OR (answer IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL)),
  CHECK(state<>'withdrawn' OR withdrawn_reason IS NOT NULL)
);
CREATE INDEX decision_request_open ON decision_request(project_id,requested_from,created_at) WHERE state='open';
