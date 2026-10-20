import { readFileSync } from "node:fs";

export const up = (pgm) => {
  pgm.sql(readFileSync(new URL("../schema/001_initial.sql", import.meta.url), "utf8"));
};

// Dropping persisted project evidence is deliberately not an automatic rollback.
export const down = false;
