// Renders @evoloop/ui components to static markup and checks the rules in docs/frontend/components.md and foundations.md.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentAvatar, AgentMark, Badge, Button, Checkbox, ConfirmDialog, CountDot, EmptyState, ErrorState, Field, IconButton, Input, ListRow, LoadingState, Logo,
  Notice, PersonAvatar, RadioGroup, RadioGroupItem, StatusTag, UnknownState, agentMarkColors, avatarLook, avatarRoleBackgrounds, systemLooks, type StatusTone,
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

test("link, row and tab buttons keep the button element and carry no pill size of their own", () => {
  const link = html(h(Button, { variant: "link", disabled: true }, "重试"));
  assert.match(link, /^<button type="button"[^>]*disabled=""/);
  assert.match(link, /text-primary/);
  assert.match(link, /hover:underline/);
  assert.doesNotMatch(link, /\bh-9\b|\bpx-4\b|text-small|rounded-full/, "a link is sized by the text around it");
  const row = html(h(Button, { variant: "row", "aria-pressed": true }, "阶段一"));
  assert.match(row, /aria-pressed="true"/);
  assert.match(row, /aria-pressed:bg-selected/);
  assert.match(row, /w-full/);
  assert.match(row, /justify-start/);
  const tab = html(h(Button, { variant: "tab", role: "tab", "aria-selected": true }, "信息"));
  assert.match(tab, /role="tab"/);
  assert.match(tab, /aria-selected="true"/);
  assert.match(tab, /aria-selected:bg-selected/);
  assert.match(html(h(Button, { variant: "link", size: "compact" }, "加载更多")), /h-\(--control-height-compact\)/, "a size given still applies");
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

test("counts are neutral and hidden at zero; a count that cannot be checked says so instead of a number", () => {
  assert.match(html(h(Badge, null, 8)), /bg-field/);
  assert.equal(html(h(CountDot, { count: 0 })), "");
  assert.match(html(h(CountDot, { count: 120 })), />99\+</);
  const unknown = html(h(CountDot, { count: null }));
  assert.match(unknown, /title="数目待核对"/);
  assert.match(unknown, /<span aria-hidden="true">\?<\/span><span class="sr-only">数目待核对<\/span>/);
  assert.match(unknown, /text-muted-foreground/);
  assert.doesNotMatch(unknown, /bg-brand|>\d/, "no number while the count is unknown");
});

test("Checkbox and RadioGroup are checkbox and radio roles, checked in the accent colour, and keep form values", () => {
  const box = html(h("form", null, h("label", null, h(Checkbox, { checked: true, name: "columns", value: "owner" }), "承接")));
  assert.match(box, /<button type="button" role="checkbox" aria-checked="true"[^>]*data-state="checked"/);
  assert.match(box, /data-\[state=checked\]:bg-primary/);
  assert.match(box, /<input type="checkbox" aria-hidden="true"[^>]*name="columns"[^>]*value="owner"/, "inside a form the value is still submitted");
  assert.match(html(h(Checkbox, { checked: false, disabled: true })), /aria-checked="false"[^>]*disabled=""/);
  const group = html(h(RadioGroup, { "aria-label": "用哪一版", value: "mine" },
    h("label", null, h(RadioGroupItem, { value: "latest" }), "用最新内容"), h("label", null, h(RadioGroupItem, { value: "mine" }), "用我的版本")));
  assert.match(group, /role="radiogroup"[^>]*aria-label="用哪一版"/);
  assert.match(group, /role="radio" aria-checked="false"[^>]*value="latest"/);
  assert.match(group, /role="radio" aria-checked="true"[^>]*value="mine"/);
  assert.match(group, /rounded-full/);
});

test("ConfirmDialog renders nothing while closed", () => {
  assert.equal(html(h(ConfirmDialog, { open: false, title: "离开当前项目？", confirmLabel: "离开", onConfirm: () => undefined, onCancel: () => undefined })), "");
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
  for (const colour of [...avatarRoleBackgrounds, ...Object.values(systemLooks).map(look => look.background), ...Object.values(agentMarkColors)]) {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map(index => Number.parseInt(colour.slice(index, index + 2), 16));
    assert.ok(!(g > r + 8 && g > b + 8), `${colour} leans green`);
  }
  const markup = html(h(AgentAvatar, { seed: "agent-a", label: "功能开发" }));
  assert.match(markup, /role="img" aria-label="功能开发"/);
  assert.match(html(h(AgentAvatar, { seed: "agent-a" })), /aria-hidden="true"/);
  assert.match(html(h(PersonAvatar, { name: "zuhriddin" })), />Z</);
  const mark = html(h(AgentMark, { color: "teal", icon: "◆", label: "测试的标识：青蓝色、菱形" }));
  assert.match(mark, /role="img" aria-label="测试的标识：青蓝色、菱形"/);
  assert.match(mark, /data-mark-color="teal"/);
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
