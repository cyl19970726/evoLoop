import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { authConfigSchema, authenticate } from "../src/auth.ts";

const entry = (extra: Record<string, unknown> = {}) => ({ token: "t".repeat(40), actorId: "docs-arch", projectIds: [randomUUID()], permissions: ["read", "write"], ...extra });

test("the identity file accepts only archive and restore as extra commands, and refuses anything else when it is read", () => {
  assert.ok(authConfigSchema.safeParse([entry({ extraCommands: ["document.archive", "document.restore"] })]).success);
  assert.ok(authConfigSchema.safeParse([entry()]).success, "the list is optional");
  for (const command of ["task.start", "task.close", "document.publish", "document.adopt", "review", ""])
    assert.equal(authConfigSchema.safeParse([entry({ extraCommands: [command] })]).success, false, `${command} is refused`);
  assert.equal(authConfigSchema.safeParse([entry({ extraCommands: "document.archive" })]).success, false);
  assert.equal(authConfigSchema.safeParse([entry({ extra_commands: ["document.archive"] })]).success, false, "the file stays strict");
});

test("an authenticated principal carries the extra commands apart from its permissions", () => {
  const config = authConfigSchema.parse([entry({ extraCommands: ["document.archive"] })]);
  const principal = authenticate(`Bearer ${"t".repeat(40)}`, config)!;
  assert.deepEqual(principal.extraCommands, ["document.archive"]);
  assert.deepEqual(principal.permissions, ["read", "write"], "permissions are not widened");
  const plain = authenticate(`Bearer ${"t".repeat(40)}`, authConfigSchema.parse([entry()]))!;
  assert.equal(plain.extraCommands, undefined);
});
