-- The daily usage ledger's cost column used to add only the cost of Runs: a message Turn wrote its tokens but a cost of 0 (defect 44ba20f6), so for a Claude
-- Session that answers mostly messages the cost was a fraction of what the tokens say. From this migration on the cost of every Turn is added.
-- History is NOT rewritten, because the per-Turn cost of a past message Turn was never stored anywhere in the database and cannot be rebuilt from it: every row
-- that exists now is marked 'runs_only' (its cost covers Runs only, its tokens cover all Turns), and every row created from now on is 'all_turns'.
-- A day that already has a row when this runs keeps 'runs_only' until it ends: its cost is complete only for the part after the change.
ALTER TABLE session_usage_daily ADD COLUMN cost_scope text NOT NULL DEFAULT 'runs_only' CHECK(cost_scope IN ('runs_only','all_turns'));
ALTER TABLE session_usage_daily ALTER COLUMN cost_scope SET DEFAULT 'all_turns';
