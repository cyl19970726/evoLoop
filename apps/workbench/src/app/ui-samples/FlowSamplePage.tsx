// Sample of 统筹安排 › 动态 on hand-written fixtures (/ui/flow). Design reference and test target of DEC-045 F1's first segment; it reads
// nothing from any instance. Two themes and the reduced-motion preference are the ones a reader would use, so the page offers the theme.
import { useEffect, useState } from "react";
import { Button } from "@evoloop/ui";
import { FlowView } from "../../features/sessions/flow/FlowView";
import { fixtureBoard, fixtureContext, fixtureEvents } from "../../features/sessions/flow/flowFixtures";

export default function FlowSamplePage() {
  const [theme, setTheme] = useState<"light" | "dark">(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <main data-ui="" className="min-h-screen bg-background p-4 text-foreground md:p-8">
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-title font-semibold">动态页样例</h1>
        <Button size="compact" onClick={() => setTheme(t => t === "light" ? "dark" : "light")} aria-pressed={theme === "dark"}>
          {theme === "dark" ? "深色（点击换浅色）" : "浅色（点击换深色）"}</Button>
      </div>
      <FlowView board={fixtureBoard} events={fixtureEvents} context={fixtureContext} source="fixture" />
    </div>
  </main>;
}
