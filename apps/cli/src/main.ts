import { readFile } from "node:fs/promises";
import { commandSchema } from "@evoloop/contracts";

const [action, input] = process.argv.slice(2);
if (!action || !input || !["command", "get"].includes(action)) {
  console.error("Usage: npm run cli -- command <json-file> | get </api/...>\nSet EVOLOOP_API_URL (default http://127.0.0.1:4318) and EVOLOOP_TOKEN.");
  process.exitCode = 2;
} else {
  const base = new URL(process.env.EVOLOOP_API_URL ?? "http://127.0.0.1:4318");
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("API URL must use HTTP(S).");
  const token = process.env.EVOLOOP_TOKEN;
  if (!token) throw new Error("Set EVOLOOP_TOKEN.");
  let command;
  if (action === "command") command = commandSchema.parse(JSON.parse(await readFile(input, "utf8")));
  const target = action === "command" ? "/api/commands" : input;
  if (!target.startsWith("/api/") || target.includes("\\") || target.startsWith("//")) throw new Error("Only /api/ paths on the configured server are allowed.");
  const url = new URL(target, base);
  if (url.origin !== base.origin) throw new Error("Cross-origin requests are not allowed.");
  if (command) console.error(`operationId=${command.operationId}; keep this ID if the response is lost.`);
  try {
    const response = await fetch(url, {
      method: command ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(command ? { "Content-Type": "application/json" } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    console.log(await response.text());
    if (!response.ok) process.exitCode = 1;
  } catch {
    console.error(command ? `Result unconfirmed. Read /api/projects/${command.projectId}/operations/${command.operationId}; do not create a new operation ID to retry.` : "Request unavailable.");
    process.exitCode = 1;
  }
}
