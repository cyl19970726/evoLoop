// Draft theme orientations (Task 0a8b17a6): they are not live. These checks keep the two proposal sheets honest: text contrast stays >= 4.5:1 and the tokens whose meaning is fixed
// (DEC-051 button colours, the warning/danger status colours) keep today's values.
import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error the measurement library is plain .mjs without declarations
import { applied, base, proposalOverrides, textContrast } from "../../../scripts/frontend/theme-lib.mjs";

const fixed = ["brand", "brand-hover", "on-brand", "warning", "warning-soft", "danger", "danger-soft"];

for (const name of ["warm", "cool"]) {
  test(`${name}: every text pair is at least 4.5:1`, () => {
    const low = textContrast(applied(name)).filter((pair: { ratio: number }) => pair.ratio < 4.5);
    assert.deepEqual(low, []);
  });
  test(`${name}: button and status-meaning tokens keep today's values`, () => {
    const over = proposalOverrides(name), live = base();
    for (const mode of ["light", "dark"] as const) for (const token of fixed) assert.equal(over[mode][token] ?? live[mode][token], live[mode][token], `${mode} ${token}`);
  });
}
