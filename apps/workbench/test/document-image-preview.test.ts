import test from "node:test";
import assert from "node:assert/strict";
import { imagePreview } from "../src/documents/imagePreview.ts";
const encoded = (hex: string) => Buffer.from(hex, "hex").toString("base64");

test("registered PNG/JPEG resources use a safe image decoder and expose a MIME mismatch", () => {
  assert.deepEqual(imagePreview("image/png", encoded("89504e470d0a1a0a0000000d49484452")), {mediaType:"image/png", mismatch:false});
  // The observed session.png resource has a JFIF header despite its PNG declaration.
  assert.deepEqual(imagePreview("image/png", encoded("ffd8ffe000104a4649460001")), {mediaType:"image/jpeg", mismatch:true});
  assert.deepEqual(imagePreview("image/jpeg", encoded("ffd8ffe000104a4649460001")), {mediaType:"image/jpeg", mismatch:false});
});
test("HTML or invalid bytes declared as PNG do not become an HTML preview", () => {
  assert.equal(imagePreview("image/png", Buffer.from("<script>example</script>").toString("base64")), null);
  assert.equal(imagePreview("image/png", "!!!!"), null);
  assert.equal(imagePreview("text/html", encoded("89504e470d0a1a0a")), null);
});
