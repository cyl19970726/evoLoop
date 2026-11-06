import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/056_pre_turn_review_decision.sql", import.meta.url), "utf8")); };
export const down = () => { throw new Error("Irreversible audited review decisions"); };
