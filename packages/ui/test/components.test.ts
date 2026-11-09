// Renders @evoloop/ui components to static markup and checks the rules in docs/frontend/components.md and foundations.md.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentAvatar, Badge, Button, CountDot, EmptyState, ErrorState, Field, IconButton, Input, ListRow, LoadingState, Logo, Notice, PersonAvatar,
  StatusTag, UnknownState, avatarLook, avatarRoleBackgrounds, systemLooks, type StatusTone,
} from "../src/index.ts";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

test("Button defaults to a secondary, typed button and renders the primary variant in ink", () => {
  const secondary = html(h(Button, null, "退回返工"));
  assert.match(secondary, /^<button type="button"/);
  assert.match(secondary, /bg-field/);
  const primary = html(h(Button, { variant: "primary" }, "通过验收"));
  assert.match(primary, /bg-foreground/);
  assert.match(primary, /text-background/);
  assert.match(primary, /text-small/);
});

test("IconButton always carries a readable name", () => {
  const markup = html(h(IconButton, { label: "设置", icon: h("svg") }));
  assert.match(markup, /aria-label="设置"/);
  assert.match(markup, /title="设置"/);
});

test("Field links the label, hint and error to its control", () => {
  const markup = html(h(Field, { label: "完成条件", hint: "写清做到什么程度算完", error: "还没写完成条件", children: props => h(Input, props) }));
  const id = markup.match(/<label for="([^"]+)"/)?.[1];
  assert.ok(id, "label has a for attribute");
  assert.match(markup, new RegExp(`<input[^>]*id="${id}"`));
  assert.match(markup, new RegExp(`aria-describedby="${id}-hint ${id}-error"`));
  assert.match(markup, /aria-invalid="true"/);
});

test("StatusTag shows text for every tone, and an icon for every tone that the status table gives one", () => {
  const withIcon: StatusTone[] = ["progress", "done", "waiting", "blocked", "unknown"];
  for (const tone of ["progress", "done", "waiting", "blocked", "idle", "unknown", "history"] as StatusTone[]) {
    const markup = html(h(StatusTag, { tone, label: "状态" }));
    assert.match(markup, />状态</, `${tone} renders its label`);
    assert.equal(markup.includes("<svg"), withIcon.includes(tone), `${tone} icon`);
  }
  assert.match(html(h(StatusTag, { tone: "blocked", label: "受阻", detail: "依据待复核" })), /受阻 · 依据待复核/);
});

test("counts are neutral and hidden at zero", () => {
  assert.match(html(h(Badge, null, 8)), /bg-field/);
  assert.equal(html(h(CountDot, { count: 0 })), "");
  assert.match(html(h(CountDot, { count: 120 })), />99\+</);
});

test("notices announce errors and state changes differently", () => {
  assert.match(html(h(Notice, { tone: "error", title: "发送失败" })), /role="alert"/);
  assert.match(html(h(Notice, { title: "有新版" })), /role="status"/);
});

test("state components say why and what next", () => {
  assert.match(html(h(EmptyState, { title: "还没有任务", reason: "总图还没有拆出任务" })), /总图还没有拆出任务/);
  assert.match(html(h(LoadingState, null)), /aria-busy="true"/);
  const error = html(h(ErrorState, { title: "没有读到", happened: "服务没有响应。", previousContentKept: true, next: "稍后自动重读。", diagnostics: "503" }));
  assert.match(error, /下面仍是上次读到的内容/);
  assert.match(error, /<details/);
  assert.match(html(h(UnknownState, { title: "结果未知", lastKnown: "已提交", reason: "机器离线" })), /最后已知：已提交/);
});

test("ListRow is a link, a button or static, and marks the selected row", () => {
  assert.match(html(h(ListRow, { title: "任务", href: "#/t", selected: true })), /^<a href="#\/t" aria-current="page"/);
  assert.match(html(h(ListRow, { title: "任务", onSelect: () => undefined, selected: true })), /^<button type="button" aria-current="true"/);
  assert.match(html(h(ListRow, { title: "任务", meta: "说明" })), /text-small[^"]*text-foreground|text-foreground[^"]*text-small/);
  assert.match(html(h(ListRow, { title: "任务" })), /^<div/);
});

test("avatars are stable, share a background within a role, and never use green", () => {
  assert.deepEqual(avatarLook("agent-a", "role-x"), avatarLook("agent-a", "role-x"));
  assert.equal(avatarLook("agent-a", "role-x").background, avatarLook("agent-b", "role-x").background);
  const hues = new Set<string>();
  for (let index = 0; index < 200; index += 1) hues.add(`${avatarLook(`agent-${index}`, `role-${index}`).hair}`);
  assert.ok(hues.size > 3, "hair styles vary between agents");
  for (const colour of [...avatarRoleBackgrounds, ...Object.values(systemLooks).map(look => look.background)]) {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map(index => Number.parseInt(colour.slice(index, index + 2), 16));
    assert.ok(!(g > r + 8 && g > b + 8), `${colour} leans green`);
  }
  const markup = html(h(AgentAvatar, { seed: "agent-a", label: "功能开发" }));
  assert.match(markup, /role="img" aria-label="功能开发"/);
  assert.match(html(h(AgentAvatar, { seed: "agent-a" })), /aria-hidden="true"/);
  assert.match(html(h(PersonAvatar, { name: "zuhriddin" })), />Z</);
});

test("the logo follows the theme tokens and thickens the loop at small sizes", () => {
  assert.match(html(h(Logo, { size: 36 })), /fill="var\(--accent\)"[\s\S]*stroke="var\(--on-accent\)"[^>]*stroke-width="2.3"/);
  assert.match(html(h(Logo, { size: 16 })), /stroke-width="2.8"/);
});

test("components use tokens, not colour literals, except the avatar illustration", () => {
  const dir = join(import.meta.dirname, "../src/components");
  for (const file of readdirSync(dir).filter(name => name !== "avatar.tsx")) {
    const source = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${file} hard-codes a colour`);
  }
});
