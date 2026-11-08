import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/066_connector_delivery_decision.sql", import.meta.url), "utf8")); };
