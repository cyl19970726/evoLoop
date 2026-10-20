import { migrate } from "@evoloop/adapter-postgres";
const url = process.env.EVOLOOP_DATABASE_URL;
if (!url) throw new Error("Set EVOLOOP_DATABASE_URL to the dedicated evoLoop database.");
await migrate(url);
