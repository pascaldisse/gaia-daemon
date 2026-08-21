import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type * as Photon from "@silvia-odwyer/photon-node";
import { photonNodeAssetPath } from "../core/paths.js";

// Lazy + dynamic on purpose: a compiled binary must never statically import
// "@silvia-odwyer/photon-node" at module scope (see vendor/photon-node/
// README-GAIA.md — its internal __dirname-based wasm load bakes to the BUILD
// MACHINE's literal path, killing every agent turn, not just image reads,
// because this module is imported eagerly by the harness). Loading the real
// on-disk vendor/ file via a genuine runtime import() keeps __dirname correct.
let photonModulePromise: Promise<typeof Photon> | undefined;
function loadPhoton(): Promise<typeof Photon> {
  if (!photonModulePromise) {
    const assetPath = photonNodeAssetPath();
    photonModulePromise = assetPath
      ? (import(pathToFileURL(assetPath).href) as Promise<typeof Photon>)
      : (import("@silvia-odwyer/photon-node") as Promise<typeof Photon>);
  }
  return photonModulePromise;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MAX_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);

export type ImageReadDetail = "low" | "med" | "high" | "full";
export type ImageReadRegion = "A1" | "B1" | "C1" | "A2" | "B2" | "C2" | "A3" | "B3" | "C3";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RenderedImage {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface GaiaImageReadResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }>;
  details: { imageRead: true; original: { width: number; height: number }; region?: ImageReadRegion };
}

/** Cheap extension/magic gate. Decoding remains authoritative; any decode failure
 * is deliberately caught by the caller and falls back to Pi's native read. */
export function mayBeImageReadPath(path: string, bytes: Uint8Array): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) || isSupportedImageMagic(bytes);
}

function isSupportedImageMagic(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    startsWithAscii(bytes, 0, "GIF") ||
    (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) ||
    startsWithAscii(bytes, 0, "BM")
  );
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}

/** Matches the ordinary native relative/absolute/~ read paths. Native remains the
 * escape hatch for Pi's rarer path-normalisation variants if this fails. */
function resolveImagePath(path: string, cwd: string): string {
  const stripped = path.startsWith("@") ? path.slice(1) : path;
  const expanded = stripped === "~" ? homedir() : stripped.startsWith("~/") ? resolve(homedir(), stripped.slice(2)) : stripped;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function detailEdge(detail: ImageReadDetail): number | undefined {
  switch (detail) {
    case "low": return 768;
    case "med": return 1280;
    case "high": return 1568;
    case "full": return undefined;
  }
}

function dimensionsFor(width: number, height: number, edge: number | undefined): { width: number; height: number } {
  if (!edge || Math.max(width, height) <= edge) return { width, height };
  const scale = edge / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function gridRect(region: ImageReadRegion, width: number, height: number): Rect {
  const column = region.charCodeAt(0) - "A".charCodeAt(0);
  const row = Number(region[1]) - 1;
  const x = Math.floor((column * width) / 3);
  const y = Math.floor((row * height) / 3);
  return { x, y, width: Math.floor(((column + 1) * width) / 3) - x, height: Math.floor(((row + 1) * height) / 3) - y };
}

function allGridRects(width: number, height: number): Array<[ImageReadRegion, Rect]> {
  return (["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "C3"] as ImageReadRegion[]).map((region) => [region, gridRect(region, width, height)]);
}

function formatRect(rect: Rect): string {
  return `(${rect.x},${rect.y},${rect.width},${rect.height})`;
}

function encodeUnderCap(photon: typeof Photon, image: Photon.PhotonImage, width: number, height: number): RenderedImage {
  let currentWidth = width;
  let currentHeight = height;
  while (true) {
    const resized = currentWidth === image.get_width() && currentHeight === image.get_height()
      ? undefined
      : photon.resize(image, currentWidth, currentHeight, photon.SamplingFilter.Lanczos3);
    const source = resized ?? image;
    try {
      const candidates: Array<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }> = [
        { bytes: source.get_bytes(), mimeType: "image/png" },
        ...[80, 70, 55, 40].map((quality) => ({ bytes: source.get_bytes_jpeg(quality), mimeType: "image/jpeg" as const })),
      ];
      const eligible = candidates
        .map((candidate) => ({ ...candidate, data: Buffer.from(candidate.bytes).toString("base64") }))
        .filter((candidate) => Buffer.byteLength(candidate.data) <= MAX_BASE64_BYTES)
        .sort((a, b) => a.data.length - b.data.length);
      if (eligible.length) {
        const best = eligible[0];
        return { data: best.data, mimeType: best.mimeType, width: currentWidth, height: currentHeight };
      }
    } finally {
      resized?.free();
    }
    if (currentWidth === 1 && currentHeight === 1) throw new Error("could not encode image under provider byte cap");
    currentWidth = Math.max(1, Math.floor(currentWidth * 0.75));
    currentHeight = Math.max(1, Math.floor(currentHeight * 0.75));
  }
}

function render(photon: typeof Photon, image: Photon.PhotonImage, edge: number | undefined): RenderedImage {
  const dimensions = dimensionsFor(image.get_width(), image.get_height(), edge);
  return encodeUnderCap(photon, image, dimensions.width, dimensions.height);
}

function imageNote(originalWidth: number, originalHeight: number, sent: RenderedImage, detail: ImageReadDetail): string {
  const scale = Math.max(sent.width / originalWidth, sent.height / originalHeight);
  const legend = allGridRects(originalWidth, originalHeight).map(([cell, rect]) => `${cell}=${formatRect(rect)}`).join(" · ");
  return [
    `Read image [${sent.mimeType}] ${originalWidth}×${originalHeight} → sent ${sent.width}×${sent.height} (detail=${detail}, resize factor ${scale.toFixed(4)}×)`,
    "grid 3×3 · A1 B1 C1 / A2 B2 C2 / A3 B3 C3",
    `original px: ${legend}`,
    'zoom: read(path, region:"B2", detail:"high")',
  ].join("\n");
}

/** Render GAIA's progressive image result. This intentionally owns no errors:
 * callers must send every failure through Pi native read, never a dead read. */
export async function readGaiaImage(path: string, cwd: string, options: { detail?: ImageReadDetail; region?: ImageReadRegion }): Promise<GaiaImageReadResult | undefined> {
  const absolutePath = resolveImagePath(path, cwd);
  const bytes = new Uint8Array(await readFile(absolutePath));
  if (!mayBeImageReadPath(path, bytes)) return undefined;

  const photon = await loadPhoton();
  const decoded = photon.PhotonImage.new_from_byteslice(bytes);
  try {
    const originalWidth = decoded.get_width();
    const originalHeight = decoded.get_height();
    const detail = options.detail ?? "low";
    const thumbnail = render(photon, decoded, 768);
    if (!options.region) {
      const rendered = detail === "low" ? thumbnail : render(photon, decoded, detailEdge(detail));
      return {
        content: [{ type: "text", text: imageNote(originalWidth, originalHeight, rendered, detail) }, { type: "image", data: rendered.data, mimeType: rendered.mimeType }],
        details: { imageRead: true, original: { width: originalWidth, height: originalHeight } },
      };
    }

    const rect = gridRect(options.region, originalWidth, originalHeight);
    const crop = photon.crop(decoded, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
    try {
      const renderedCrop = render(photon, crop, detailEdge(detail));
      const cropNote = `Read image crop ${options.region} of 3×3, orig rect ${formatRect(rect)} → sent ${renderedCrop.width}×${renderedCrop.height} (detail=${detail})`;
      return {
        content: [
          { type: "text", text: `${imageNote(originalWidth, originalHeight, thumbnail, "low")}\n${cropNote}` },
          { type: "image", data: thumbnail.data, mimeType: thumbnail.mimeType },
          { type: "image", data: renderedCrop.data, mimeType: renderedCrop.mimeType },
        ],
        details: { imageRead: true, original: { width: originalWidth, height: originalHeight }, region: options.region },
      };
    } finally {
      crop.free();
    }
  } finally {
    decoded.free();
  }
}
