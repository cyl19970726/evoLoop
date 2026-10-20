# Isolated Codex App Server experiment

This is a research fixture, not evoLoop's production harness, TaskStore, Wiki, or scheduler. It uses the existing Codex CLI login without reading credentials or changing account configuration. Tested with `codex-cli 0.154.0`; generate that executable's schema before using another version. Python 3.10+ standard library only.

Offline failure-boundary checks:

```sh
python3 -m unittest discover -s scripts/research/codex-app-server -v
```

After authorizing live model use, choose an available model from the local `model/list` result and run from the repository root:

```sh
python3 scripts/research/codex-app-server/verify.py \
  --output .local/codex-proof/run-NEW \
  --model gpt-6-astra --effort low --run-live
```

The output directory must not exist. Keep it private and ignored: it contains prompts, native IDs, paths, model output and protocol journals. Do not commit it. An optional `--desktop-thread ID` performs only a metadata read of a specifically authorized existing thread. It never resumes or writes to that desktop thread. Desktop messaging is a separate host-tool operation, deliberately absent from this standalone client.

The run creates two persistent protocol threads, executes four model turns, starts and closes three owned stdio server processes, and leaves the threads and private evidence for inspection. It never archives user chats, changes a desktop database, clears locks, or stops an existing daemon. Normal global Codex config, hooks, MCP startup and instruction loading still apply; the fixture's instructions restrict model work but do not isolate the whole CLI environment. Inspect returned instruction sources and journals before generalizing the result. `workspace-write` disables model-command network access in the tested server policy; this is not an OS-level isolation guarantee for the entire server.

Checks distinguish protocol completion, artifact correctness and cognition consumption. One completed event is received and journaled but deliberately ignored by the experiment's durable reducer; a new server reads paginated history to repair the state. This is not a dropped TCP connection or killing an in-flight task. In the measured run, the receiver had three successful command items that read evidence and recalculated hashes/arithmetic. Its structured receipt is checked independently.

A checkpoint simulates a notification dispatcher stopping after receiver completion but before recording consumption: the connection is closed, outbox is reloaded, history and receipt are checked, then marked consumed. The same notification is not dispatched again, and receiver history must still contain one turn. This is a single-dispatcher experiment with a known turn ID; it does not prove cross-process locking, atomic RPC + journal writes, exactly-once delivery, power-loss durability, or recovery of a lost `turn/start` response. `dispatching_unknown` is never automatically retried. A failed live run preserves evidence and stops; inspect it rather than reusing the directory or blindly repeating a write. The script reruns a full experiment; it is not a production recovery CLI for an arbitrary interrupted run.

Unexpected server approval/input requests fail closed with an unsupported-request response. There is no interactive approval UI. Live approval, interruption, concurrent writers, Feishu, production Wiki and scheduling remain outside this experiment.
