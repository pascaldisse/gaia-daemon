// apple -- local Apple dictation (SFSpeechRecognizer, "local Siri") STT engine.
// Ported from the standalone apple-stt skill (~/Downloads/apple-stt/transcribe.ts,
// same swift helper + on-device|server race, same TCC-disclaim cure) into a
// daemon-native engine: works over SttAudioInput bytes instead of a CLI file
// arg. macOS only, zero API keys, zero network for the on-device pass.
//
// registerSttEngine({ id: "apple", ... }) happens in transcribe.ts (RULE #0:
// engine is DATA, the shared transcribe() path never branches on engine id) --
// this file only exports the pure transcribe function so importing it here
// from transcribe.ts stays a one-way (non-circular) import.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { globalPaths } from "../core/paths.js";
import type { SttContext, SttResult } from "./transcribe.js";

// ---------------------------------------------------------------------------
// Swift helper. Embedded string -> cached compile keyed by source hash (same
// cache dir/scheme the standalone skill uses, so the two share one compiled
// binary when both are present on a machine).
//
// TCC scar: spawned processes inherit the SPAWNER as responsible process ->
// SIGABRT without its usage-description plist. Cure baked in: self re-exec
// posix_spawn SETEXEC + responsibility_spawnattrs_setdisclaim + embedded
// __info_plist + bundle-shaped cache dir + stable codesign identifier. Do not
// strip any of these -- proven necessary on real clips (see apple-stt SKILL.md).

const SWIFT_SOURCE = `
import Foundation
import Speech

typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
func respawnDisclaimed() -> Never {
  var attr: posix_spawnattr_t? = nil
  posix_spawnattr_init(&attr)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
  if let sym = dlsym(dlopen(nil, RTLD_NOW), "responsibility_spawnattrs_setdisclaim") {
    let disclaim = unsafeBitCast(sym, to: DisclaimFn.self)
    _ = disclaim(&attr, 1)
  }
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
  argv.append(strdup("--disclaimed"))
  argv.append(nil)
  var pid: pid_t = 0
  posix_spawn(&pid, CommandLine.arguments[0], nil, &attr, argv, environ)
  FileHandle.standardError.write("disclaim re-exec failed\\n".data(using: .utf8)!)
  exit(70)
}

if !CommandLine.arguments.contains("--disclaimed") { respawnDisclaimed() }
let args = CommandLine.arguments.filter { $0 != "--disclaimed" }
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: gaia-apple-stt <audio> [locale] [device|server]\\n".data(using: .utf8)!)
  exit(64)
}
let audioUrl = URL(fileURLWithPath: args[1])
let locale: Locale = args.count >= 3 && !args[2].isEmpty ? Locale(identifier: args[2]) : Locale.current
// ONE recognition session per process (in-process device+server race hangs
// both -- measured). The race lives in the TS layer: one process per mode.
let onDevice = (args.count >= 4 ? args[3] : "device") != "server"

if SFSpeechRecognizer.authorizationStatus() != .authorized {
  let authSema = DispatchSemaphore(value: 0)
  SFSpeechRecognizer.requestAuthorization { _ in authSema.signal() }
  authSema.wait()
}
guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
  FileHandle.standardError.write("speech recognition not authorized (System Settings > Privacy & Security > Speech Recognition)\\n".data(using: .utf8)!)
  exit(2)
}
guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
  FileHandle.standardError.write("no speech recognizer for locale \\(locale.identifier)\\n".data(using: .utf8)!)
  exit(3)
}
if onDevice && !recognizer.supportsOnDeviceRecognition {
  FileHandle.standardError.write("on-device recognition unsupported for \\(locale.identifier)\\n".data(using: .utf8)!)
  exit(5)
}
let request = SFSpeechURLRecognitionRequest(url: audioUrl)
request.shouldReportPartialResults = false
request.requiresOnDeviceRecognition = onDevice
request.taskHint = .dictation
if #available(macOS 13.0, *) {
  request.addsPunctuation = true
}
recognizer.recognitionTask(with: request) { result, error in
  if let result = result, result.isFinal {
    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { exit(6) }
    print(text)
    exit(0)
  }
  if let error = error {
    FileHandle.standardError.write("recognition failed: \\(error.localizedDescription)\\n".data(using: .utf8)!)
    exit(4)
  }
}
dispatchMain()
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>works.earendil.gaia.apple-stt</string>
  <key>CFBundleName</key><string>gaia-apple-stt</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>GAIA transcribes your dictated voice messages locally on this Mac.</string>
</dict></plist>
`;

function binDir(): string {
  return globalPaths.cacheBinDir();
}

function helperPath(log: (message: string) => void): string {
  const hash = createHash("sha256").update(SWIFT_SOURCE).update(INFO_PLIST).digest("hex").slice(0, 12);
  const contents = join(binDir(), `gaia-apple-stt-${hash}.app`, "Contents");
  const path = join(contents, "MacOS", "gaia-apple-stt");
  if (!existsSync(path)) {
    log("apple STT: compiling helper (first run, ~2s)\u2026");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    const source = join(binDir(), `gaia-apple-stt-${hash}.swift`);
    const plist = join(contents, "Info.plist");
    writeFileSync(source, SWIFT_SOURCE);
    writeFileSync(plist, INFO_PLIST);
    const result = spawnSync("swiftc", [
      "-O", "-o", path, source,
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist,
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`swiftc failed (install Xcode Command Line Tools: xcode-select --install): ${(result.stderr ?? "").slice(0, 800)}`);
    }
    const signed = spawnSync("codesign", ["-s", "-", "-f", "--identifier", "works.earendil.gaia.apple-stt", path], { encoding: "utf8" });
    if (signed.status !== 0) {
      throw new Error(`codesign failed: ${(signed.stderr ?? "").slice(0, 400)}`);
    }
    chmodSync(path, 0o755);
  }
  return path;
}

interface RunResult { code: number; stdout: string; stderr: string }

function run(command: string[], signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"], signal });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c) => out.push(c));
    child.stderr?.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

// ISO-639-1 language hint (what SttContext.language carries, e.g. "en", "de")
// -> a concrete BCP-47 locale SFSpeechRecognizer accepts. Already-BCP-47
// hints ("en-US") pass through unchanged; empty/unmapped = system locale
// (Locale.current in the helper, same as the standalone skill's default).
const LOCALE_MAP: Record<string, string> = {
  en: "en-US", de: "de-DE", es: "es-ES", fr: "fr-FR", it: "it-IT",
  pt: "pt-BR", nl: "nl-NL", pl: "pl-PL", ru: "ru-RU", uk: "uk-UA",
  ja: "ja-JP", ko: "ko-KR", zh: "zh-CN", ar: "ar-SA", hi: "hi-IN", tr: "tr-TR",
};

export function appleLocale(language: string | undefined): string {
  const lang = (language ?? "").trim();
  if (!lang || lang.toLowerCase() === "auto") return "";
  if (lang.includes("-")) return lang;
  return LOCALE_MAP[lang.toLowerCase()] ?? lang;
}

const STT_APPLE_TIMEOUT_MS = 120_000;

export async function appleTranscribe(context: SttContext): Promise<SttResult> {
  if (process.platform !== "darwin") {
    throw new Error('STT engine "apple" requires macOS (SFSpeechRecognizer)');
  }
  const signal = context.signal ?? AbortSignal.timeout(STT_APPLE_TIMEOUT_MS);
  const helper = helperPath(context.log);
  const work = await mkdtemp(join(tmpdir(), "gaia-stt-apple-"));
  try {
    // ffmpeg content-probes the input container, so the extension-less temp
    // name below decodes fine for the webm/mp4/wav/... clips the composer and
    // uploads produce.
    const input = join(work, "clip.input");
    writeFileSync(input, context.audio.data);
    const wav = join(work, "clip.wav");
    // speechnorm, NEVER loudnorm -- loudnorm's ramp-in eats the first spoken
    // words (proven on real clips, see apple-stt SKILL.md).
    const FF_ARGS = ["-ac", "1", "-ar", "16000", "-af", "speechnorm=e=6.25:r=0.00001:l=1", "-f", "wav", "-y"];
    const decode = await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", input, ...FF_ARGS, wav], signal);
    if (decode.code !== 0 || !existsSync(wav)) {
      throw new Error(`ffmpeg could not decode the clip: ${decode.stderr.slice(0, 400)}`);
    }
    const locale = appleLocale(context.language);
    // Race: on-device wins if it yields text; quiet clips fall through to
    // server dictation (keyless, free), already in flight -- no serial second
    // pass. SFSpeech = one session per PROCESS, so the race is two helper
    // processes, never two sessions in one process (proven to hang both).
    const serverPass = run([helper, wav, locale, "server"], signal);
    serverPass.catch(() => {});
    const device = await run([helper, wav, locale, "device"], signal).catch(() => null);
    if (device && device.code === 0 && device.stdout.trim()) {
      return { text: device.stdout.trim() };
    }
    const server = await serverPass;
    if (server.code !== 0 || !server.stdout.trim()) {
      throw new Error(`Apple speech recognition failed (${server.code}): ${(server.stderr || device?.stderr || "").trim().slice(0, 400)}`);
    }
    return { text: server.stdout.trim() };
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
