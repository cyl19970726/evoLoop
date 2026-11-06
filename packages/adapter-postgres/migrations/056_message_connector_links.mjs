import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/056_message_connector_links.sql", import.meta.url), "utf8")); };
