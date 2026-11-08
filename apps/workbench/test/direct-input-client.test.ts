import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { ApiError } from "../src/api";
import { directInputClient, explicitlyUnaccepted } from "../src/sessions/directInputClient";

test("direct input distinguishes a missing receipt after 503 from an explicit pre-reservation rejection", async t => {
  let submitStatus = 503;
  let submitCode = "SERVICE_UNAVAILABLE";
  let submitMessage = "commit outcome unknown";
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/direct-input-capability")) {
      response.end(JSON.stringify({ items: [] })); // A 200 from an older route is not a capability.
    } else if (request.method === "POST") {
      response.statusCode = submitStatus;
      response.end(JSON.stringify({ code: submitCode, message: submitMessage }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ code: "NOT_FOUND", message: "no readable receipt yet" }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => originalFetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init);
  t.after(() => { globalThis.fetch = originalFetch; });
  const client = directInputClient("fixture-token", "97000001-0000-4000-8000-000000000001", "97000002-0000-4000-8000-000000000002");
  await assert.rejects(client.capability(), (error: unknown) => error instanceof ApiError && error.status === 0);
  const command = { inputId: "97000003-0000-4000-8000-000000000003",
    operationId: "97000004-0000-4000-8000-000000000004", content: "sample", expectedTurnId: null };
  let cause: unknown;
  try { await client.submit(command); } catch (error) { cause = error; }
  assert.ok(cause instanceof ApiError && cause.status === 503);
  await assert.rejects(client.read(command.inputId), (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.equal(explicitlyUnaccepted(cause), false, "503 followed by read 404 cannot release the original intent");
  submitStatus = 400;
  submitCode = "INVALID_INPUT";
  submitMessage = "rejected before reservation";
  try { await client.submit(command); } catch (error) { cause = error; }
  assert.equal(explicitlyUnaccepted(cause), true, "structured validation rejection precedes reservation");
  submitStatus = 409;
  submitCode = "DIRECT_GRANT_MISSING";
  submitMessage = "exact direct grant is unavailable";
  try { await client.submit(command); } catch (error) { cause = error; }
  assert.equal(explicitlyUnaccepted(cause), true, "a pre-reservation direct grant denial is an explicit rejection");
  assert.equal(paths.filter(path => path.includes("/direct-inputs") && path.startsWith("POST")).length, 3);
});
