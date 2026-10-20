"""Bounded stdio research client. Not a production SessionRuntime adapter."""

import json
import queue
import subprocess
import threading
import time
from pathlib import Path


class RpcError(RuntimeError):
    pass


class Client:
    def __init__(self, directory, label, executable="codex"):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.log = open(self.directory / f"{label}.jsonl", "a", encoding="utf-8")
        self.stderr = open(self.directory / f"{label}.stderr", "a", encoding="utf-8")
        self.process = subprocess.Popen(
            [executable, "app-server", "--stdio"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.stderr, text=True, bufsize=1,
        )
        self.inbox = queue.Queue()
        self.events = []
        self.next_id = 0
        self.lock = threading.Lock()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def record(self, direction, message):
        with self.lock:
            self.log.write(json.dumps({"time": time.time(), "direction": direction,
                                       "message": message}, ensure_ascii=False) + "\n")
            self.log.flush()

    def _read(self):
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                self.record("receive", message)
                self.inbox.put(message)
        except Exception as error:
            self.inbox.put(error)
        finally:
            self.inbox.put(EOFError("App Server stdout closed"))

    def send(self, message):
        self.record("send", message)
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def receive(self, deadline):
        try:
            message = self.inbox.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty as error:
            raise TimeoutError("RPC/event deadline expired; outcome unknown, do not resend") from error
        if isinstance(message, Exception):
            raise message
        if "method" in message and "id" in message:
            # Fail closed: this experiment has no interactive approval surface.
            self.send({"id": message["id"], "error": {
                "code": -32601, "message": "Research client cannot handle server request"}})
            raise RpcError("Unexpected server request: " + message["method"])
        return message

    def rpc(self, method, params, timeout=90):
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            message = self.receive(deadline)
            if message.get("id") == request_id:
                if "error" in message:
                    raise RpcError(json.dumps(message["error"]))
                return message["result"]
            if "id" not in message:
                self.events.append(message)
            else:
                raise RpcError("Unexpected response ID")

    def initialize(self):
        result = self.rpc("initialize", {"clientInfo": {
            "name": "evoloop_research", "title": "evoLoop isolated protocol research",
            "version": "0.1.0"}})
        self.send({"method": "initialized", "params": {}})
        return result

    def wait_turn(self, thread_id, turn_id, timeout=300):
        deadline = time.monotonic() + timeout
        while True:
            for index, message in enumerate(self.events):
                params = message.get("params", {})
                if (message.get("method") == "turn/completed"
                        and params.get("threadId") == thread_id
                        and params.get("turn", {}).get("id") == turn_id):
                    self.events.pop(index)
                    turn = params["turn"]
                    if turn["status"] != "completed":
                        raise RpcError("Turn did not complete: " + json.dumps(turn))
                    return turn
            self.events.append(self.receive(deadline))

    def pages(self, method, params):
        data, cursor, seen = [], None, set()
        for _ in range(100):
            page = self.rpc(method, {**params, **({"cursor": cursor} if cursor else {})})
            data.extend(page["data"])
            cursor = page.get("nextCursor")
            if not cursor:
                return data
            if cursor in seen:
                raise RpcError("Pagination cursor repeated")
            seen.add(cursor)
        raise RpcError("Research pagination bound exceeded")

    def close(self):
        # Only terminate the subprocess this object created, never the desktop app/daemon.
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        self.record("process_exit", {"pid": self.process.pid, "code": self.process.returncode})
        self.log.close()
        self.stderr.close()
