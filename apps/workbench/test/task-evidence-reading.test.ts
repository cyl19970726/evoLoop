import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsumerObservation } from "@evoloop/contracts";
import { EvidenceText, evidencePreview } from "../src/workflow/EvidenceText.tsx";
import { observationResultLabel, observationsForDelivery, observerKindLabel } from "../src/workflow/observationPresentation.ts";

test("short evidence stays visible; long Unicode original remains complete behind disclosure", () => {
  const short = "首行\n复核通过";
  const visible = renderToStaticMarkup(createElement(EvidenceText, { label: "技术检查证据", value: short }));
  assert.match(visible, /首行\n复核通过/);
  assert.doesNotMatch(visible, /<details/);

  const long = "🧪".repeat(241) + "\n最后一行与原始结论";
  const preview = evidencePreview(long);
  assert.equal(preview, "🧪".repeat(160) + "…");
  assert.equal(Array.from(preview ?? "").length, 161);
  const collapsed = renderToStaticMarkup(createElement(EvidenceText, { label: "使用证据", value: long }));
  assert.match(collapsed, /<details[^>]*><summary>展开完整使用证据<\/summary>/);
  assert.ok(collapsed.includes(`<p>${long}</p>`), "disclosure preserves the exact original, including its last line");
  const manyLines = "🧪\n".repeat(100) + "末行";
  assert.equal(evidencePreview(manyLines), "🧪\n🧪\n🧪\n🧪…", "a short-line preview stays within four lines");
  const expandedLines = renderToStaticMarkup(createElement(EvidenceText, { label: "记录理由", value: manyLines }));
  assert.ok(expandedLines.includes(`<p>${manyLines}</p>`), "all original lines remain in the disclosure");
});

test("latest failed observation remains scoped to its delivery with registered kind, result, time and full reason", () => {
  const old = { id: "old-use", deliveryId: "old", observer: "旧观察", observerKind: "human", result: "used" } as ConsumerObservation;
  const reason = "本次访问失败。".repeat(35);
  const failed = { id: "new-failed", deliveryId: "new", observer: "核对者", observerKind: "agent", result: "failed", evidence: "实际读取失败", reason, actorId: "reviewer", createdAt: "2026-10-24T02:00:00.000Z" } as ConsumerObservation;
  assert.deepEqual(observationsForDelivery([old, failed], "new"), [failed]);
  assert.equal(observerKindLabel[failed.observerKind], "登记为 Agent");
  assert.equal(observationResultLabel[failed.result], "使用失败");
  assert.equal(observationResultLabel[old.result], "已使用");
  const renderedReason = renderToStaticMarkup(createElement(EvidenceText, { label: "记录理由", value: failed.reason }));
  assert.match(renderedReason, /展开完整记录理由/);
  assert.ok(renderedReason.includes(`<p>${reason}</p>`));
});
