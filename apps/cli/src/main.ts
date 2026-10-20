import { runCli } from "./application.js";

process.exitCode = await runCli(process.argv.slice(2));
