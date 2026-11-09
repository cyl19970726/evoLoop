import { readFileSync } from "node:fs";
export const up = pgm => { pgm.sql(readFileSync(new URL("../schema/068_role_runtime_profile.sql", import.meta.url), "utf8")); };
export const down = () => { throw new Error("Role runtime bindings are append only"); };
