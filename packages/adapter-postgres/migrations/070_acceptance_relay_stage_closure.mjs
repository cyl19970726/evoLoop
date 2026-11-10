import { readFileSync } from "node:fs";
export const up = pgm => {
  pgm.sql(readFileSync(new URL("../schema/070_acceptance_relay_stage_closure.sql", import.meta.url), "utf8"));
};
export const down = false;
