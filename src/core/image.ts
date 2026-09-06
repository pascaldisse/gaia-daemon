import { pathToFileURL } from "node:url";
import type * as Photon from "@silvia-odwyer/photon-node";
import { photonNodeAssetPath } from "./paths.js";
// Lazy + dynamic on purpose: a compiled binary must never statically import
// "@silvia-odwyer/photon-node" at module scope (see vendor/photon-node/
// README-GAIA.md — its internal __dirname-based wasm load bakes to the BUILD
// MACHINE's literal path, killing every agent turn, not just image reads,
// because this module is imported eagerly by the harness). Loading the real
// on-disk vendor/ file via a genuine runtime import() keeps __dirname correct.
let photonModulePromise: Promise<typeof Photon> | undefined;
export function loadPhoton(): Promise<typeof Photon> {
  if (!photonModulePromise) {
    const assetPath = photonNodeAssetPath();
    photonModulePromise = assetPath
      ? (import(pathToFileURL(assetPath).href) as Promise<typeof Photon>)
      : (import("@silvia-odwyer/photon-node") as Promise<typeof Photon>);
  }
  return photonModulePromise;
}


export const IMAGE_MAX_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);
export interface RenderedImage {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}
export function encodeUnderCap(photon: typeof Photon, image: Photon.PhotonImage, width: number, height: number, maxBase64Bytes = IMAGE_MAX_BASE64_BYTES): RenderedImage {
  let currentWidth = width;
  let currentHeight = height;
  while (true) {
    const resized = currentWidth === image.get_width() && currentHeight === image.get_height()
      ? undefined
      : photon.resize(image, currentWidth, currentHeight, photon.SamplingFilter.Lanczos3);
    const source = resized ?? image;
    try {
      // Lossless first; stop at the highest JPEG quality that fits.
      for (const quality of [undefined, 80, 70, 55, 40]) {
        const bytes = quality === undefined ? source.get_bytes() : source.get_bytes_jpeg(quality);
        if (4 * Math.ceil(bytes.length / 3) > maxBase64Bytes) continue;
        return {
          data: Buffer.from(bytes).toString("base64"),
          mimeType: quality === undefined ? "image/png" : "image/jpeg",
          width: currentWidth,
          height: currentHeight,
        };
      }
    } finally {
      resized?.free();
    }
    if (currentWidth === 1 && currentHeight === 1) throw new Error("could not encode image under provider byte cap");
    currentWidth = Math.max(1, Math.floor(currentWidth * 0.75));
    currentHeight = Math.max(1, Math.floor(currentHeight * 0.75));
  }
}


/** Provider copy only → original bytes/path remain untouched. */
export async function normalizeImage(bytes: Uint8Array, mimeType: string, maxBase64Bytes = IMAGE_MAX_BASE64_BYTES): Promise<{ data: string; mimeType: string }> {
  if (!Number.isFinite(maxBase64Bytes) || maxBase64Bytes < 1024) throw new Error("invalid image byte cap");
  if (4 * Math.ceil(bytes.byteLength / 3) <= maxBase64Bytes) return { data: Buffer.from(bytes).toString("base64"), mimeType };
  const photon = await loadPhoton();
  const image = photon.PhotonImage.new_from_byteslice(bytes);
  try { return encodeUnderCap(photon, image, image.get_width(), image.get_height(), maxBase64Bytes); }
  finally { image.free(); }
}
