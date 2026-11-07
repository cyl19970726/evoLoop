import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/060_message_connector_standard.sql", import.meta.url), "utf8")); };
