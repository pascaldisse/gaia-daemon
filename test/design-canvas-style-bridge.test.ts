// Bridge: the design canvas ships to the browser through web/src/design ->
// ../../design/web. Guard the served path, not just the submodule path.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const served = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "design", "artifact-canvas.js");
const servedModel = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "design", "canvas-model.js");
const servedStyle = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "design", "canvas-style.js");

test("served design canvas assigns explicit CSSOM properties only", async () => {
  const code = (await readFile(served, "utf8")).replace(/^\/\/.*$/gm, "");
  assert.equal(code.includes("cssText"), false);
  assert.equal(/setAttribute\(\s*["']style["']/.test(code), false);
  assert.match(code, /applyElementStyle\(node, element\)/);
  const styleCode = (await readFile(servedStyle, "utf8")).replace(/^\/\/.*$/gm, "");
  assert.equal(styleCode.includes("cssText"), false);
});

test("served design canvas bounds untrusted values", async () => {
  const module = await import(servedStyle);
  const values = module.elementStyleValues({ id: "a", kind: "box", x: 5, y: 5, w: 1e9, h: 40, fill: "red;position:fixed;inset:0" });
  assert.equal(values.backgroundColor, "var(--accent)");
  assert.equal(values.width, `${module.STAGE_BOUNDS.width}px`);
});

test("served canvas edits retain unknown root and element metadata", async () => {
  const { parseDesign } = await import(servedModel);
  const design = parseDesign(JSON.stringify({
    futureRoot: { keep: true },
    elements: [{ id: "a", kind: "box", x: 10, y: 10, w: 100, h: 50, futureElement: ["keep"] }],
  }));
  design.elements[0].x = 42;
  const serialized = JSON.parse(JSON.stringify(design));
  assert.deepEqual(serialized.futureRoot, { keep: true });
  assert.deepEqual(serialized.elements[0].futureElement, ["keep"]);
  assert.equal(serialized.elements[0].x, 42);
});
