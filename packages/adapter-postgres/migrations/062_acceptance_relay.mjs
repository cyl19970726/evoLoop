import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/062_acceptance_relay.sql", import.meta.url), "utf8")); };
export const down = () => { throw new Error("Acceptance relay history is immutable"); };
