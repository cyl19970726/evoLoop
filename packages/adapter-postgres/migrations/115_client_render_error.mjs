import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/115_client_render_error.sql", import.meta.url), "utf8")); };
export const down = false;
