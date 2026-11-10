// A date and time on the clock of a record's time zone (shared/zonedTime.ts "A time field that was filled from a
// record"): a date-time control, the line saying what it becomes, and, for a reading that happens twice when daylight
// saving ends, the choice of which of the two. The control and the line are always drawn, so typing is never cut off by
// the line appearing.
import { createElement as h } from "react";
import { Input, RadioGroup, RadioGroupItem } from "@evoloop/ui";
import { joinTimeField, repeatedInstants, splitTimeField, timeFieldPreview, utcText } from "../zonedTime";

const minute = (iso: string) => Math.floor(Date.parse(iso) / 60_000);

export interface LocalTimeInputProps {
  control: { id: string; "aria-describedby"?: string | undefined; "aria-invalid"?: boolean | undefined };
  name: string; value: string; timezone: string; onChange(value: string): void;
  /** Say what the reading becomes (off for a field the chosen rule does not use). */
  active?: boolean | undefined;
}

export function LocalTimeInput({ control, name, value, timezone, onChange, active = true }: LocalTimeInputProps) {
  const { local, instant } = splitTimeField(value);
  const repeated = active && local.trim() ? repeatedInstants(local, timezone) : null;
  const later = !!repeated && !!instant && minute(instant) === minute(repeated.later);
  const choose = (which: "earlier" | "later") => onChange(joinTimeField({ local, instant: which === "later" ? repeated!.later : repeated!.earlier }));
  const option = (which: "earlier" | "later", label: string) => h("label", { key: which, className: "flex items-center gap-1.5" },
    h(RadioGroupItem, { value: which }), label);
  // The line is spaced by its own margin, which it drops while empty: it takes no room then, yet stays in the
  // accessibility tree, so the status is announced when its first words appear (display:none would not be).
  return h("div", { className: "flex min-w-0 flex-col" },
    h(Input, { ...control, name, type: "datetime-local", step: /:\d{2}:\d{2}$/.test(local) ? 1 : 60, value: local, autoComplete: "off",
      onChange: event => onChange((event.target as HTMLInputElement).value) }),
    h("div", { role: "status", "data-field-preview": name, className: "mt-1.5 text-caption text-text-secondary empty:mt-0 [overflow-wrap:anywhere]" },
      active ? timeFieldPreview(value, timezone) : null),
    repeated && h(RadioGroup, { "aria-label": "这一当地时刻出现两次，用哪一次", name: `${name}-occurrence`, value: later ? "later" : "earlier",
      onValueChange: (which: string) => choose(which === "later" ? "later" : "earlier"), className: "mt-1.5 gap-1 text-caption text-foreground" },
      h("span", { className: "text-text-secondary" }, "这一当地时刻在夏令时结束时出现两次。协调器的每日规则取较早的一次；这里按所选的一次记录。"),
      option("earlier", `较早一次（${utcText(repeated.earlier)}）`), option("later", `较晚一次（${utcText(repeated.later)}）`)));
}
