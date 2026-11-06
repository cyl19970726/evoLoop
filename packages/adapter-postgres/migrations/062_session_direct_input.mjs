import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/062_session_direct_input.sql", import.meta.url), "utf8")); };
export const down = () => { throw new Error("Direct input evidence is append only"); };
