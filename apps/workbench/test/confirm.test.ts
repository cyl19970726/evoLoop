// shared/confirm.ts: questions asked before the design system has loaded never outlive the sign-in they were asked in
// and never wait for a dialog that cannot appear.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerConfirm, askConfirm, cancelConfirms, confirmHostFailed, confirmHostMounted, currentConfirm, hostWaitMs, onConfirmRetry, onConfirmUnavailable,
} from "../src/shared/confirm";

const ask = (title: string) => askConfirm({ title, confirmLabel: "离开" });

test("questions are shown one at a time and answered in order", async () => {
  const unmount = confirmHostMounted();
  const first = ask("离开当前项目？"), second = ask("退出并清除草稿？");
  assert.equal(currentConfirm()?.title, "离开当前项目？");
  answerConfirm(true);
  assert.equal(currentConfirm()?.title, "退出并清除草稿？");
  answerConfirm(false);
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(currentConfirm(), null);
  unmount();
});

test("signing out, a 401 or the host leaving the page answers every open question with cancel", async () => {
  const unmount = confirmHostMounted();
  const open = [ask("离开当前项目？"), ask("退出并清除草稿？")];
  cancelConfirms();
  assert.deepEqual(await Promise.all(open), [false, false]);
  assert.equal(currentConfirm(), null, "nothing is left to come back after signing in again");
  const later = ask("离开当前项目？");
  unmount();
  assert.equal(await later, false, "the host leaving the page cancels too");
  assert.equal(currentConfirm(), null);
});

test("a host that cannot load cancels what waits and says so; questions then end at once until it mounts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const said: string[] = [];
  const stop = onConfirmUnavailable(() => said.push("unavailable"));
  const waiting = ask("离开当前项目？");
  confirmHostFailed();
  assert.equal(await waiting, false);
  assert.deepEqual(said, ["unavailable"]);
  assert.equal(await ask("退出并清除草稿？"), false);
  assert.equal(currentConfirm(), null);
  assert.deepEqual(said, ["unavailable", "unavailable"]);
  // Once the host mounts (a reload of the chunk worked), questions are shown again.
  const unmount = confirmHostMounted();
  const shown = ask("离开当前项目？");
  assert.equal(currentConfirm()?.title, "离开当前项目？");
  answerConfirm(true);
  assert.equal(await shown, true);
  unmount();
  stop();
});

test("a question waits for the host at most hostWaitMs, then is cancelled", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const said: string[] = [];
  const stop = onConfirmUnavailable(() => said.push("unavailable"));
  const waiting = ask("离开当前项目？");
  t.mock.timers.tick(hostWaitMs - 1);
  assert.equal(currentConfirm()?.title, "离开当前项目？", "still waiting for the dialog's code");
  t.mock.timers.tick(1);
  assert.equal(await waiting, false);
  assert.deepEqual(said, ["unavailable"]);
  // A host that mounted in time is not cancelled by the wait.
  const unmount = confirmHostMounted();
  const shown = ask("退出并清除草稿？");
  t.mock.timers.tick(hostWaitMs * 2);
  assert.equal(currentConfirm()?.title, "退出并清除草稿？");
  answerConfirm(false);
  assert.equal(await shown, false);
  unmount();
  stop();
});

test("#295 item 6: after a failed load the next question asks for another try and is shown once the dialog mounts, so a draft is not locked in until a refresh", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const said: string[] = [];
  const stop = onConfirmUnavailable(() => said.push("unavailable"));
  const first = ask("离开当前项目？");
  confirmHostFailed();
  assert.equal(await first, false, "the question that was waiting when the load failed is cancelled");
  // Someone can load the dialog again (the app): a new question asks for it and waits for it.
  let retries = 0, unmount: (() => void) | null = null;
  const stopRetry = onConfirmRetry(() => { retries++; unmount = confirmHostMounted(); });
  const again = ask("离开当前项目？");
  assert.equal(retries, 1, "the failed load is tried again when asked again");
  assert.equal(currentConfirm()?.title, "离开当前项目？", "and the question is on screen, not cancelled");
  answerConfirm(true);
  assert.equal(await again, true);
  assert.deepEqual(said, ["unavailable"], "only the first, cancelled question was reported as unavailable");
  unmount?.(); stopRetry();
  // A retry that does not bring the dialog up in time still ends the question, and the next question tries again.
  confirmHostFailed();
  const stopRetry2 = onConfirmRetry(() => { retries++; });
  const stuck = ask("退出并清除草稿？");
  t.mock.timers.tick(hostWaitMs);
  assert.equal(await stuck, false);
  assert.equal(retries, 2);
  const next = ask("退出并清除草稿？");
  assert.equal(retries, 3, "every later question is another chance");
  t.mock.timers.tick(hostWaitMs);
  assert.equal(await next, false);
  stopRetry2(); stop();
});
