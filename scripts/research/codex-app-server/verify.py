#!/usr/bin/env python3
"""Real model-backed fixture, explicit opt-in; private evidence stays in --output."""

import argparse
import hashlib
import json
import secrets
import subprocess
import time
from pathlib import Path

from client import Client


def save(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        import os
        os.fsync(stream.fileno())
    temporary.replace(path)


def load(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def completed(turns, turn_id):
    matches = [turn for turn in turns if turn["id"] == turn_id]
    if len(matches) != 1 or matches[0]["status"] != "completed":
        raise AssertionError("Persisted completed turn not found")
    return matches[0]


def may_dispatch(outbox):
    # An ambiguous or already accepted request must be reconciled, never resent.
    return outbox["status"] == "pending"


def validate_receipt(receipt, delivery, artifact):
    assert receipt["notificationId"] == delivery["notificationId"]
    assert receipt["taskId"] == delivery["taskId"]
    assert receipt["inputRevision"] == delivery["inputRevision"]
    assert receipt["artifactSha256"] == delivery["artifactSha256"]
    assert receipt["observedTotal"] == artifact["total"]
    assert receipt["decision"] == "accepted"
    assert isinstance(receipt["nextAction"], str) and receipt["nextAction"].strip()


def run(root, model, effort, desktop_id=None):
    root.mkdir(parents=True, exist_ok=False)
    workspace = root / "fixture"
    workspace.mkdir()
    save(workspace / "input.json", {"taskId": "fixture-sum", "revision": 1,
                                    "values": [12, 7, 5]})
    # A local fixture instruction, not a globally installed skill or a real task DB.
    (workspace / "AGENTS.md").write_text(
        "This is an isolated evoLoop research fixture. Use only files in this directory. "
        "Do not use network, MCP, delegation, plugins, or external services. "
        "Use local command tools to read and write the requested JSON. "
        "Do not change AGENTS.md or input.json. Do not ask for confirmation.\n")
    marker = secrets.token_hex(12)
    state = {"startedAt": time.time(), "cli": subprocess.check_output(
        ["codex", "--version"], text=True).strip(), "requestedModel": model,
        "effort": effort, "threads": {}, "turns": {}, "checks": {}, "processes": []}
    save(root / "state.json", state)
    client = None

    def persist():
        save(root / "state.json", state)

    def connect(label):
        nonlocal client
        client = Client(root, label)
        client.initialize()
        state["processes"].append({"label": label, "pid": client.process.pid})
        persist()

    def disconnect():
        nonlocal client
        client.close()
        state["processes"][-1]["exitCode"] = client.process.returncode
        client = None
        persist()

    def start(role):
        response = client.rpc("thread/start", {
            "model": model, "cwd": str(workspace), "sandbox": "workspace-write",
            "approvalPolicy": "never", "ephemeral": False,
            "serviceName": "evoloop_research",
            "developerInstructions": "Bounded research task. Follow the fixture AGENTS.md. "
                                     "Do not delegate or access other projects."})
        state["threads"][role] = {"id": response["thread"]["id"],
            "model": response["model"], "modelProvider": response["modelProvider"],
            "instructionSources": response.get("instructionSources", [])}
        persist()
        return response["thread"]["id"]

    def turn(role, label, prompt):
        thread_id = state["threads"][role]["id"]
        # Intent is durable before RPC; timeout is deliberately not auto-retried.
        state["turns"][label] = {"status": "requested", "threadId": thread_id}
        persist()
        response = client.rpc("turn/start", {"threadId": thread_id,
            "effort": effort, "input": [{"type": "text", "text": prompt}]})
        turn_id = response["turn"]["id"]
        state["turns"][label].update(id=turn_id, status="accepted")
        persist()
        result = client.wait_turn(thread_id, turn_id)
        if label == "revision2":
            # Fault injection at the consumer, after transport receipt: do not apply
            # this terminal event to our durable state. History must repair it.
            state["checks"]["completionNotificationIgnored"] = True
        else:
            state["turns"][label]["status"] = result["status"]
        persist()
        print(label + ": model turn completed", flush=True)
        return result

    def history(role):
        thread_id = state["threads"][role]["id"]
        turns = client.pages("thread/turns/list", {"threadId": thread_id,
            "limit": 1, "itemsView": "full", "sortDirection": "asc"})
        items = client.pages("thread/items/list", {"threadId": thread_id,
            "limit": 2, "sortDirection": "asc"})
        save(root / f"{role}-history.json", {"turns": turns, "items": items})
        return turns, items

    try:
        connect("connection1")
        if desktop_id:
            metadata = client.rpc("thread/read", {"threadId": desktop_id,
                                                    "includeTurns": False})
            save(root / "desktop-metadata.json", metadata)
            state["checks"]["desktopMetadataReadable"] = True
        worker = start("worker")
        turn("worker", "revision1", f"Task fixture-sum revision 1. Read input.json and "
             "write delivery.v1.json with taskId, inputRevision (from revision), count, total. "
             f"Remember this conversation-only marker for later: {marker}. "
             "Do not write the marker into any file or repeat it in your reply. "
             "Actually read the file and create the JSON artifact, then finish briefly.")
        first = load(workspace / "delivery.v1.json")
        assert first == {"taskId": "fixture-sum", "inputRevision": 1, "count": 3, "total": 24}
        first_hash = digest(workspace / "delivery.v1.json")
        save(workspace / "input.json", {"taskId": "fixture-sum", "revision": 2,
                                        "values": [12, 7, 5, 9]})
        turn("worker", "revision2", "Continue the same task at input revision 2. "
             "Read input.json AND delivery.v1.json. Write delivery.v2.json with taskId, "
             "inputRevision, count, total, previousTotal from v1, previousSha256 computed "
             "from the actual v1 file bytes, and priorMarker from our previous conversation. "
             "Do not use any other directory. Then finish briefly.")
        second = load(workspace / "delivery.v2.json")
        assert second == {"taskId": "fixture-sum", "inputRevision": 2, "count": 4,
            "total": 33, "previousTotal": 24, "previousSha256": first_hash,
            "priorMarker": marker}
        assert state["turns"]["revision2"]["status"] == "accepted"
        disconnect()
        connect("connection2")
        client.rpc("thread/read", {"threadId": worker, "includeTurns": False})
        turns, items = history("worker")
        completed(turns, state["turns"]["revision2"]["id"])
        assert len(turns) == 2
        state["turns"]["revision2"]["status"] = "completed_reconciled"
        state["checks"]["persistedHistoryAfterRestart"] = True
        state["checks"]["historyItemCount"] = len(items)
        client.rpc("thread/resume", {"threadId": worker, "excludeTurns": True})
        turn("worker", "resumed", "After this process restart, read delivery.v2.json. "
             "Write resumed.json containing taskId, inputRevision, total, and "
             "conversationMarker: the original conversation-only marker you were asked "
             "to remember in the first turn. Check that it agrees with priorMarker "
             "in the actual artifact. Do not change existing artifacts.")
        resumed = load(workspace / "resumed.json")
        assert resumed == {"taskId": "fixture-sum", "inputRevision": 2, "total": 33,
                           "conversationMarker": marker}
        turns, items = history("worker")
        assert len(turns) == 3
        completed(turns, state["turns"]["resumed"]["id"])
        state["checks"]["artifactAndContextChecks"] = True
        state["checks"]["workerTurnCount"] = len(turns)
        save(workspace / "execution-evidence.json", {"fixture": True,
            "checks": state["checks"], "turns": state["turns"],
            "model": state["threads"]["worker"]["model"]})
        notification_id = "fixture-completed-" + secrets.token_hex(8)
        delivery = {"fixture": True, "notificationId": notification_id,
            "taskId": "fixture-sum", "inputRevision": 2,
            "artifact": "delivery.v2.json", "artifactSha256": digest(workspace / "delivery.v2.json"),
            "evidence": "execution-evidence.json"}
        save(workspace / "completion-notice.json", delivery)
        start("cognition")
        outbox = {"notificationId": notification_id, "status": "pending"}
        save(root / "outbox.json", outbox)
        assert may_dispatch(outbox)
        outbox["status"] = "dispatching_unknown"
        save(root / "outbox.json", outbox)
        turn("cognition", "cognition", "Act as the cognition receiver for this isolated "
             "research task. A completion notice is available at completion-notice.json. "
             "Actually READ that notice, its evidence file, input.json, delivery.v1.json, "
             "delivery.v2.json, and resumed.json using local tools. Independently check "
             "the arithmetic, revision, prior-file hash, and final artifact SHA256. "
             "Write cognition-receipt.json with notificationId, taskId, inputRevision, "
             "artifactSha256, observedTotal, decision (accepted or rejected), rationale, "
             "evidenceRead (file names), and nextAction (a specific next experiment and "
             "its reason). This is a fixture, not Feishu or a production Wiki. Do not "
             "send any message to another session. Finish with your judgment.")
        # Crash boundary: receipt exists, but dispatcher has not committed consumed.
        outbox.update(status="accepted", turnId=state["turns"]["cognition"]["id"],
                      threadId=state["threads"]["cognition"]["id"])
        save(root / "outbox.json", outbox)
        disconnect()
        connect("connection3")
        outbox = load(root / "outbox.json")
        assert not may_dispatch(outbox)
        turns, items = history("cognition")
        completed(turns, outbox["turnId"])
        receipt = load(workspace / "cognition-receipt.json")
        validate_receipt(receipt, delivery, second)
        required = {"completion-notice.json", "execution-evidence.json", "input.json",
                    "delivery.v1.json", "delivery.v2.json", "resumed.json"}
        assert required <= set(receipt["evidenceRead"])
        commands = [item for t in turns for item in t["items"]
                    if item["type"] == "commandExecution" and item.get("exitCode") == 0]
        assert commands, "No successful actual tool execution in cognition history"
        save(root / "cognition-tool-evidence.json", commands)
        outbox.update(status="consumed", receiptSha256=digest(workspace / "cognition-receipt.json"))
        save(root / "outbox.json", outbox)
        assert not may_dispatch(load(root / "outbox.json"))
        after, _ = history("cognition")
        assert len(after) == len(turns) == 1
        state["checks"].update(cognitionConsumed=True, duplicateDispatchSuppressed=True,
                               cognitionToolCount=len(commands), cognitionTurnCount=len(after))
        state["finishedAt"] = time.time()
        state["result"] = "passed"
        persist()
        print("PASS: artifacts, restart reconciliation, cognition consumption and dedup", flush=True)
    except Exception as error:
        state["result"] = "failed"
        state["error"] = str(error)
        persist()
        raise
    finally:
        if client:
            disconnect()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path,
                        help="NEW private ignored directory; contains prompts/history/paths")
    parser.add_argument("--model", required=True)
    parser.add_argument("--effort", default="low")
    parser.add_argument("--desktop-thread", help="Optional explicitly authorized metadata-only target")
    parser.add_argument("--run-live", action="store_true", help="Authorize four billable model turns")
    args = parser.parse_args()
    if not args.run_live:
        parser.error("Live execution requires --run-live; existing Codex login is used")
    run(args.output.resolve(), args.model, args.effort, args.desktop_thread)
