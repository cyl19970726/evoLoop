// TEMPORARY demo for Task f5b420a2: a test that sleeps past the per-test cap must fail by name. Reverted right after.
import test from "node:test";
test("HANG-DEMO this test sleeps past the per-test timeout", async () => { await new Promise(r => setTimeout(r, 600_000)); });
