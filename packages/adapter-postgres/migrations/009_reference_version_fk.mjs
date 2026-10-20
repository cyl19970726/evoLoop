import { readFileSync } from "node:fs";

export const up = (pgm) => { pgm.sql(readFileSync(new URL("../schema/009_reference_version_fk.sql", import.meta.url), "utf8")); };
export const down = false;
