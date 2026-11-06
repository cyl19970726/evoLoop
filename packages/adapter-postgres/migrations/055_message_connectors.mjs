import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/055_message_connectors.sql", import.meta.url), "utf8")); };
