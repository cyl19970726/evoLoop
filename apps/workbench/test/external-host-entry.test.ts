import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import { externalHostOpenHref, externalHostOpenReason } from "../src/roles/externalHostEntry.ts";

const ref = "01a158d7-f842-7ca3-9899-ce1efc33c030";
const host = {host:{kind:"external",provider:"codex-desktop",ref},state:"verified",verifiedCapabilities:["open"]} as HostLink;
test("only verified Codex Desktop UUID refs create a supported chat deep link", () => {
  assert.equal(externalHostOpenHref(host,"active"),`codex://threads/${ref}`);
  assert.equal(externalHostOpenHref({...host,host:{...host.host,ref:`${ref}?prompt=send`}},"active"),null);
  assert.equal(externalHostOpenHref({...host,host:{...host.host,ref:"javascript:alert(1)"}},"active"),null);
  assert.equal(externalHostOpenHref({...host,host:{...host.host,provider:"other"}},"active"),null);
  assert.equal(externalHostOpenHref({...host,state:"revoked"},"active"),null);
  assert.equal(externalHostOpenHref({...host,state:"registered"},"active"),null);
  assert.equal(externalHostOpenHref({...host,verifiedCapabilities:["read"]},"active"),null);
  assert.equal(externalHostOpenHref(host,"retired"),null);
  assert.match(externalHostOpenReason({...host,host:{...host.host,provider:"other"}},"active",true),/类型不支持/);
  assert.match(externalHostOpenReason({...host,host:{...host.host,ref:"javascript:alert(1)"}},"active",true),/不是完整的 Codex 聊天 UUID/);
  assert.match(externalHostOpenReason({...host,state:"revoked"},"active",true),/已撤权/);
  assert.match(externalHostOpenReason(host,"retired",true),/职责当前不承接/);
});
