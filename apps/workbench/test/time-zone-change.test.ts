// #295 item 4: revising a schedule and changing only the time zone must not move a moment that was filled from the record, and says so beside the time.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { LocalTimeInput } from "../src/shared/ui/LocalTimeInput.ts";
import { timeFieldAfterZoneChange, timeFieldInstant, timeFieldValue } from "../src/shared/zonedTime.ts";

const instant = "2026-12-01T01:30:00.000Z";

test("a time filled from the record keeps its instant when only the zone changes; the clock reading is worked out in the new zone", () => {
  const filled = timeFieldValue(instant, "UTC");                  // 01:30 on the UTC clock
  const shifted = timeFieldAfterZoneChange(filled, "UTC", "Asia/Shanghai");
  assert.equal(timeFieldInstant(shifted.value, "Asia/Shanghai"), instant, "the same moment");
  assert.match(shifted.value, /^2026-12-01T09:30\|/, "now read on the Shanghai clock");
  assert.match(shifted.note!, /时区改成了 Asia\/Shanghai：这个时刻不变/);
  // Without the fix the stored reading would have been re-read on the new clock: a different moment.
  assert.notEqual(timeFieldInstant("2026-12-01T01:30", "Asia/Shanghai"), instant);
});

test("a time typed by hand has no moment to keep: it is read on the new zone's clock, and that is said", () => {
  const typed = timeFieldAfterZoneChange("2026-12-01T01:30", "UTC", "Asia/Shanghai");
  assert.equal(typed.value, "2026-12-01T01:30");
  assert.match(typed.note!, /现在按 Asia\/Shanghai 的当地时间算，不是原来那个时刻/);
});

test("nothing is said or moved for an empty field, the same zone, or a zone the browser does not know", () => {
  assert.deepEqual(timeFieldAfterZoneChange("", "UTC", "Asia/Shanghai"), { value: "", note: null });
  const filled = timeFieldValue(instant, "UTC");
  assert.deepEqual(timeFieldAfterZoneChange(filled, "UTC", "UTC"), { value: filled, note: null });
  assert.deepEqual(timeFieldAfterZoneChange(filled, "UTC", "Not/AZone"), { value: filled, note: null });
});

/** The field as a component, rendered outside a renderer: state and refs in slots, effects after the render whose deps changed. */
function runner() {
  const slots: unknown[] = [];
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return (props: Parameters<typeof LocalTimeInput>[0]) => {
    let index = 0; const effects: Array<() => void> = [];
    const dispatcher = {
      useState(initial: unknown) { const at = index++; if (!(at in slots)) slots[at] = initial; return [slots[at], (next: unknown) => { slots[at] = next; }]; },
      useRef(initial: unknown) { const at = index++; if (!(at in slots)) slots[at] = { current: initial }; return slots[at]; },
      useEffect(effect: () => void, deps?: unknown[]) { const at = index++; const before = slots[at] as unknown[] | undefined;
        if (!before || !deps || deps.length !== before.length || deps.some((dep, i) => !Object.is(dep, before[i]))) effects.push(effect); slots[at] = deps; },
    };
    const previous = internals.H; internals.H = dispatcher;
    let tree: unknown; try { tree = LocalTimeInput(props); } finally { internals.H = previous; }
    for (const effect of effects) effect();
    return tree;
  };
}

test("the field writes the shifted value back when the zone changes, and shows the note beside the time", () => {
  const changes: string[] = [];
  const render = runner();
  const control = { id: "x" };
  const filled = timeFieldValue(instant, "UTC");
  render({ control, name: "expiresLocal", value: filled, timezone: "UTC", onChange: value => changes.push(value) });
  assert.deepEqual(changes, [], "nothing on the first render");
  render({ control, name: "expiresLocal", value: filled, timezone: "Asia/Shanghai", onChange: value => changes.push(value) });
  assert.equal(changes.length, 1);
  assert.equal(timeFieldInstant(changes[0]!, "Asia/Shanghai"), instant, "the moment is the same");
  const after = render({ control, name: "expiresLocal", value: changes[0]!, timezone: "Asia/Shanghai", onChange: () => undefined });
  assert.match(JSON.stringify(after), /data-zone-change/);
  assert.match(JSON.stringify(after), /这个时刻不变/);
});
