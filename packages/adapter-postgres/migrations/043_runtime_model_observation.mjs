import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/043_runtime_model_observation.sql", import.meta.url), "utf8")); };
export const down = false;
