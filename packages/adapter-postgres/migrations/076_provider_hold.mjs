import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/076_provider_hold.sql", import.meta.url), "utf8")); };
export const down = false;
