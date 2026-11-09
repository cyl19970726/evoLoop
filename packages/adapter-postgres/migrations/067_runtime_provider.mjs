import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/067_runtime_provider.sql", import.meta.url), "utf8")); };
export const down = () => { throw new Error("Runtime provider identity and reported accounting are append only"); };
