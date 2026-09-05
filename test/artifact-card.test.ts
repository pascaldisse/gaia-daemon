import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../design/test/artifact-card.test.js";

const styles = readFileSync(join(import.meta.dir, "../web/src/styles.css"), "utf8");

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance([red, green, blue]: [number, number, number]): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(left: [number, number, number], right: [number, number, number]): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

test("artifact card text meets WCAG AA contrast in every theme", () => {
  assert.match(styles, /\.artifact-tab \{[^}]*color: var\(--fg\);/);
  assert.match(styles, /\.artifact-tab-meta \{[^}]*color: var\(--fg\);/);
  assert.doesNotMatch(styles, /\.artifact-tab\.active \.artifact-tab-meta \{[^}]*opacity:/);
  const themes = [...styles.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)];
  assert.ok(themes.length >= 8);
  for (const [, id, body] of themes) {
    const bg = rgb(body.match(/--bg:\s*(#[0-9a-f]{6})/i)?.[1] ?? "");
    const foreground = rgb(body.match(/--fg:\s*(#[0-9a-f]{6})/i)?.[1] ?? "");
    const accent = rgb(body.match(/--accent:\s*(#[0-9a-f]{6})/i)?.[1] ?? "");
    const ink = bg.map((channel) => Math.round(channel * 0.55)) as [number, number, number];
    assert.ok(contrast(foreground, ink) >= 4.5, `${id} inactive card contrast`);
    assert.ok(contrast(accent, ink) >= 4.5, `${id} active card contrast`);
  }
});
