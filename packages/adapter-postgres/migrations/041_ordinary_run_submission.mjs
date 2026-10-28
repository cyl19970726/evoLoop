import { readFileSync } from 'node:fs';
export const up = pgm => { pgm.sql(readFileSync(new URL('../schema/041_ordinary_run_submission.sql', import.meta.url), 'utf8')); };
export const down = false;
