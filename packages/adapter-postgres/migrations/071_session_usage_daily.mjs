import { readFileSync } from "node:fs";
export const up = pgm => {
  pgm.sql(readFileSync(new URL("../schema/071_session_usage_daily.sql", import.meta.url), "utf8"));
};
export const down = false;
