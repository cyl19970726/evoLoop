import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/069_document_revision_history.sql", import.meta.url), "utf8")); };
export const down = false;
