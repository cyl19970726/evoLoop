"""Deterministic failure-boundary checks; these do not substitute for live evidence."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

from client import Client, RpcError
from verify import completed, may_dispatch, save, load, validate_receipt


class ProtocolChecks(unittest.TestCase):
    def bare(self, messages):
        client = object.__new__(Client)
        client.next_id = 0
        client.events = []
        client.send = Mock()
        client.receive = Mock(side_effect=messages)
        return client

    def test_event_before_response_is_preserved_and_matched_by_turn(self):
        event = {"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": "turn", "status": "completed"}}}
        other = {"method": "turn/completed", "params": {
            "threadId": "other", "turn": {"id": "turn", "status": "failed"}}}
        client = self.bare([other, event, {"id": 1, "result": {"turn": {"id": "turn"}}}])
        client.rpc("turn/start", {})
        self.assertEqual(client.wait_turn("thread", "turn")["status"], "completed")
        self.assertEqual(client.events, [other])

    def test_failed_terminal_event_does_not_pass(self):
        client = self.bare([])
        client.events = [{"method": "turn/completed", "params": {
            "threadId": "thread", "turn": {"id": "turn", "status": "failed"}}}]
        with self.assertRaises(RpcError):
            client.wait_turn("thread", "turn")

    def test_unexpected_approval_fails_closed(self):
        client = object.__new__(Client)
        client.inbox = Mock()
        client.inbox.get.return_value = {"id": "approval", "method": "item/commandExecution/requestApproval"}
        client.send = Mock()
        with self.assertRaises(RpcError):
            client.receive(time.monotonic() + 1)
        self.assertIn("error", client.send.call_args.args[0])

    def test_repeated_cursor_is_bounded(self):
        client = self.bare([])
        client.rpc = Mock(return_value={"data": [], "nextCursor": "same"})
        with self.assertRaises(RpcError):
            client.pages("thread/turns/list", {})
        self.assertEqual(client.rpc.call_count, 2)

    def test_rpc_timeout_is_not_retried(self):
        client = self.bare([TimeoutError("unknown")])
        with self.assertRaises(TimeoutError):
            client.rpc("turn/start", {})
        self.assertEqual(client.send.call_count, 1)

    def test_missing_or_inprogress_history_does_not_reconcile(self):
        for turns in [[], [{"id": "t", "status": "inProgress"}]]:
            with self.assertRaises(AssertionError):
                completed(turns, "t")


class DeliveryChecks(unittest.TestCase):
    def test_only_new_pending_notification_can_be_dispatched(self):
        self.assertTrue(may_dispatch({"status": "pending"}))
        for state in ["dispatching_unknown", "accepted", "consumed"]:
            self.assertFalse(may_dispatch({"status": state}))

    def test_stale_or_corrupt_receipt_is_rejected(self):
        delivery = {"notificationId": "n", "taskId": "t", "inputRevision": 2,
                    "artifactSha256": "expected"}
        good = {**delivery, "observedTotal": 33, "decision": "accepted", "nextAction": "check X"}
        validate_receipt(good, delivery, {"total": 33})
        for key, bad in [("notificationId", "old"), ("inputRevision", 1),
                         ("artifactSha256", "corrupt"), ("observedTotal", 24),
                         ("decision", "rejected"), ("nextAction", "")]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                validate_receipt({**good, key: bad}, delivery, {"total": 33})

    def test_checkpoint_is_readable_after_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.json"
            save(path, {"status": "accepted", "turnId": "t"})
            save(path, {"status": "consumed", "turnId": "t"})
            self.assertEqual(load(path), {"status": "consumed", "turnId": "t"})
            self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
