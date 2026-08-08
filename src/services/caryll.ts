import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

export type CaryllStats = { tokensBefore: number; tokensAfter: number; ratio: number; legendEntries: number };

type Segment = { kind: "verbatim" | "compressible"; text: string };
type Occurrence = { segment: number; start: number; end: number };
type Candidate = {
  phrase: string;
  occurrences: Occurrence[];
  initialNet: number;
};
type Selection = { phrase: string; alias: string; occurrences: Occurrence[]; net: number };
type Replacement = { start: number; end: number; alias: string };

type RawCandidate = { phrase: string; sampledOccurrences: number; roughScore: number };

const HEADER = "~caryll/1";
const SEPARATOR = "~~";
const URL_AT_RE = /^https?:\/\/\S+/;
const MIN_CANDIDATE_CHARS = 8;
const MAX_CANDIDATE_CHARS = 120;
const MIN_OCCURRENCES = 3;
const MAX_INDEX_ENTRIES = 2_000_000;
const MAX_RAW_CANDIDATES_FOR_SCORING = 100_000;
const MAX_EXTENSION_NODES = 2_000_000;
const TOP_CANDIDATES = 512;
const MAX_SCORED_CANDIDATES_FOR_GREEDY = 10_000;

export function compressCaryll(text: string): { output: string; stats: CaryllStats } {
  const segments = splitSegments(text);
  const candidates = collectCandidates(segments);
  const selected = selectCandidates(segments, text, candidates);
  const body = applySelections(segments, selected);
  const legend = selected.map((entry) => `~L ${entry.alias}=${entry.phrase}`);
  const output = [HEADER, ...legend, SEPARATOR].join("\n") + "\n" + body;
  const tokensBefore = tokenCount(text);
  const tokensAfter = tokenCount(output);
  return {
    output,
    stats: {
      tokensBefore,
      tokensAfter,
      ratio: tokensBefore === 0 ? 1 : tokensAfter / tokensBefore,
      legendEntries: selected.length,
    },
  };
}

export function expandCaryll(text: string): string {
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  if (firstLine !== HEADER) throw new Error("Caryll header is not '~caryll/1'");

  let pos = firstLineEnd === -1 ? text.length : firstLineEnd + 1;
  const legend: Array<{ alias: string; expansion: string }> = [];

  while (pos <= text.length) {
    const next = text.indexOf("\n", pos);
    const lineEnd = next === -1 ? text.length : next;
    const line = text.slice(pos, lineEnd);
    pos = next === -1 ? text.length : next + 1;

    if (line === SEPARATOR) {
      let body = text.slice(pos);
      for (const entry of [...legend].sort((a, b) => b.alias.length - a.alias.length)) {
        body = body.replace(new RegExp(`${escapeRegExp(entry.alias)}(?!\\d)`, "g"), entry.expansion);
      }
      return body;
    }

    if (!line.startsWith("~L ")) throw new Error("Invalid Caryll legend line");
    const equals = line.indexOf("=", 3);
    if (equals === -1) throw new Error("Invalid Caryll legend entry");
    legend.push({ alias: line.slice(3, equals), expansion: line.slice(equals + 1) });
  }

  throw new Error("Invalid Caryll file: missing separator");
}

function tokenCount(text: string): number {
  return countTokens(text);
}

function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let compressible = "";
  let i = 0;
  let inQuotedString = false;

  const flush = () => {
    if (compressible.length > 0) {
      segments.push({ kind: "compressible", text: compressible });
      compressible = "";
    }
  };

  while (i < text.length) {
    if (inQuotedString) {
      compressible += text[i];
      if (text[i] === '"' && !isEscaped(text, i)) inQuotedString = false;
      i += 1;
      continue;
    }

    if (text.startsWith("```", i)) {
      flush();
      const close = text.indexOf("```", i + 3);
      const end = close === -1 ? text.length : close + 3;
      segments.push({ kind: "verbatim", text: text.slice(i, end) });
      i = end;
      continue;
    }

    const url = text.slice(i).match(URL_AT_RE)?.[0];
    if (url) {
      flush();
      segments.push({ kind: "verbatim", text: url });
      i += url.length;
      continue;
    }

    if (text[i] === "`") {
      flush();
      const close = text.indexOf("`", i + 1);
      const end = close === -1 ? text.length : close + 1;
      segments.push({ kind: "verbatim", text: text.slice(i, end) });
      i = end;
      continue;
    }

    compressible += text[i];
    if (text[i] === '"' && !isEscaped(text, i)) inQuotedString = true;
    i += 1;
  }

  flush();
  return segments;
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function collectCandidates(segments: Segment[]): Candidate[] {
  const shingleIndex = buildShingleIndex(segments);
  const rawCandidates = new Map<string, RawCandidate>();
  let extensionNodes = 0;

  for (const occurrences of shingleIndex.values()) {
    if (occurrences.length < MIN_OCCURRENCES) continue;
    extensionNodes = mineExtensions(segments, occurrences, rawCandidates, extensionNodes);
    if (extensionNodes >= MAX_EXTENSION_NODES) break;
  }

  const candidates: Candidate[] = [];
  const scoredRaw = [...rawCandidates.values()]
    .sort((a, b) => b.roughScore - a.roughScore || b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase))
    .slice(0, maxRawCandidatesForScoring(segments));

  for (const raw of scoredRaw) {
    const occurrences = findOccurrences(segments, raw.phrase);
    if (occurrences.length < MIN_OCCURRENCES) continue;
    const initialNet = netSavings(raw.phrase, "~A1", occurrences.length);
    if (initialNet <= 0) continue;
    candidates.push({ phrase: raw.phrase, occurrences, initialNet });
  }

  return candidates
    .sort((a, b) => b.initialNet - a.initialNet || b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase))
    .slice(0, MAX_SCORED_CANDIDATES_FOR_GREEDY);
}

function maxRawCandidatesForScoring(segments: Segment[]): number {
  const totalChars = segments.reduce((sum, segment) => sum + (segment.kind === "compressible" ? segment.text.length : 0), 0);
  if (totalChars > 5_000_000) return 512;
  if (totalChars > 1_000_000) return 2_048;
  return MAX_RAW_CANDIDATES_FOR_SCORING;
}

function buildShingleIndex(segments: Segment[]): Map<string, Occurrence[]> {
  const anchorCount = segments.reduce((sum, segment) => {
    if (segment.kind !== "compressible") return sum;
    return sum + Math.max(0, segment.text.length - MIN_CANDIDATE_CHARS + 1);
  }, 0);
  let step = 1;
  while (Math.ceil(anchorCount / step) > MAX_INDEX_ENTRIES) step *= 2;

  const index = new Map<string, Occurrence[]>();
  segments.forEach((segment, segmentIndex) => {
    if (segment.kind !== "compressible") return;
    for (let start = 0; start <= segment.text.length - MIN_CANDIDATE_CHARS; start += step) {
      const shingle = segment.text.slice(start, start + MIN_CANDIDATE_CHARS);
      if (!isLegendSafeCandidate(shingle)) continue;
      const occurrences = index.get(shingle) ?? [];
      occurrences.push({ segment: segmentIndex, start, end: start + MIN_CANDIDATE_CHARS });
      index.set(shingle, occurrences);
    }
  });
  return index;
}

function mineExtensions(
  segments: Segment[],
  initialOccurrences: Occurrence[],
  rawCandidates: Map<string, RawCandidate>,
  extensionNodes: number,
): number {
  const stack: Occurrence[][] = [initialOccurrences];

  while (stack.length > 0 && extensionNodes < MAX_EXTENSION_NODES) {
    const occurrences = stack.pop();
    if (!occurrences || occurrences.length < MIN_OCCURRENCES) continue;
    extensionNodes += 1;

    const length = occurrences[0].end - occurrences[0].start;
    if (length >= MIN_CANDIDATE_CHARS && (length === MIN_CANDIDATE_CHARS || length % 4 === 0)) {
      rememberRawCandidate(segments, occurrences, rawCandidates);
    }
    if (length >= MAX_CANDIDATE_CHARS) continue;

    const groups = new Map<string, Occurrence[]>();
    for (const occurrence of occurrences) {
      const segmentText = segments[occurrence.segment]?.text ?? "";
      if (occurrence.end >= segmentText.length) continue;
      const nextChar = segmentText[occurrence.end];
      if (nextChar === "\n" || nextChar === "\r") continue;
      const group = groups.get(nextChar) ?? [];
      group.push({ ...occurrence, end: occurrence.end + 1 });
      groups.set(nextChar, group);
    }

    let extended = false;
    for (const group of groups.values()) {
      if (group.length < MIN_OCCURRENCES) continue;
      extended = true;
      stack.push(group);
    }

    if (!extended && length % 4 !== 0) {
      rememberRawCandidate(segments, occurrences, rawCandidates);
    }
  }

  return extensionNodes;
}

function rememberRawCandidate(segments: Segment[], occurrences: Occurrence[], rawCandidates: Map<string, RawCandidate>): void {
  const first = occurrences[0];
  const phrase = segments[first.segment]?.text.slice(first.start, first.end) ?? "";
  if (!isLegendSafeCandidate(phrase)) return;
  const sampledOccurrences = occurrences.length;
  const roughScore = sampledOccurrences * Math.max(0, phrase.length - 3) - phrase.length;
  const existing = rawCandidates.get(phrase);
  if (!existing || sampledOccurrences > existing.sampledOccurrences) {
    rawCandidates.set(phrase, { phrase, sampledOccurrences, roughScore });
  }
}

function isLegendSafeCandidate(phrase: string): boolean {
  return (
    phrase.length >= MIN_CANDIDATE_CHARS &&
    phrase.length <= MAX_CANDIDATE_CHARS &&
    !phrase.includes("\n") &&
    !phrase.includes("\r")
  );
}

function findOccurrences(segments: Segment[], phrase: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  segments.forEach((segment, segmentIndex) => {
    if (segment.kind !== "compressible") return;
    let pos = 0;
    while (pos <= segment.text.length - phrase.length) {
      const found = segment.text.indexOf(phrase, pos);
      if (found === -1) break;
      occurrences.push({ segment: segmentIndex, start: found, end: found + phrase.length });
      pos = found + 1;
    }
  });
  return occurrences;
}

function selectCandidates(segments: Segment[], originalText: string, candidates: Candidate[]): Selection[] {
  const occupied = new Map<number, Array<{ start: number; end: number }>>();
  const selected: Selection[] = [];
  const aliasPrefix = chooseAliasPrefix(originalText, TOP_CANDIDATES);

  for (const candidate of candidates) {
    if (selected.length >= TOP_CANDIDATES) break;
    const available = nonOverlappingOccurrences(
      candidate.occurrences.filter(
        (occurrence) =>
          !overlapsAny(occupied.get(occurrence.segment) ?? [], occurrence) && !isFollowedByDigit(segments, occurrence),
      ),
    );
    if (available.length < MIN_OCCURRENCES) continue;
    const alias = `${aliasPrefix}${selected.length + 1}`;
    const net = netSavings(candidate.phrase, alias, available.length);
    if (net <= 0) continue;

    selected.push({ phrase: candidate.phrase, alias, occurrences: available, net });
    for (const occurrence of available) {
      const ranges = occupied.get(occurrence.segment) ?? [];
      ranges.push({ start: occurrence.start, end: occurrence.end });
      occupied.set(occurrence.segment, ranges);
    }
  }

  return selected;
}

function chooseAliasPrefix(originalText: string, maxAliases: number): string {
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    const prefix = `~${String.fromCharCode(code)}`;
    let clean = true;
    for (let i = 1; i <= maxAliases; i += 1) {
      if (originalText.includes(`${prefix}${i}`)) {
        clean = false;
        break;
      }
    }
    if (clean) return prefix;
  }
  throw new Error("Unable to find a Caryll alias prefix absent from input");
}

function isFollowedByDigit(segments: Segment[], occurrence: Occurrence): boolean {
  const next = segments[occurrence.segment]?.text[occurrence.end];
  return next !== undefined && /[0-9]/.test(next);
}

function applySelections(segments: Segment[], selected: Selection[]): string {
  const replacements = new Map<number, Replacement[]>();
  for (const selection of [...selected].sort((a, b) => b.phrase.length - a.phrase.length)) {
    for (const occurrence of selection.occurrences) {
      const entries = replacements.get(occurrence.segment) ?? [];
      entries.push({ start: occurrence.start, end: occurrence.end, alias: selection.alias });
      replacements.set(occurrence.segment, entries);
    }
  }

  return segments
    .map((segment, index) => {
      if (segment.kind === "verbatim") return segment.text;
      const entries = (replacements.get(index) ?? []).sort((a, b) => a.start - b.start || b.end - a.end);
      let out = "";
      let pos = 0;
      for (const entry of entries) {
        out += segment.text.slice(pos, entry.start);
        out += entry.alias;
        pos = entry.end;
      }
      out += segment.text.slice(pos);
      return out;
    })
    .join("");
}

function nonOverlappingOccurrences(occurrences: Occurrence[]): Occurrence[] {
  const selected: Occurrence[] = [];
  const occupied = new Map<number, Array<{ start: number; end: number }>>();
  for (const occurrence of [...occurrences].sort((a, b) => a.segment - b.segment || a.start - b.start || b.end - a.end)) {
    const ranges = occupied.get(occurrence.segment) ?? [];
    if (overlapsAny(ranges, occurrence)) continue;
    ranges.push({ start: occurrence.start, end: occurrence.end });
    occupied.set(occurrence.segment, ranges);
    selected.push(occurrence);
  }
  return selected;
}

function netSavings(phrase: string, alias: string, occurrences: number): number {
  return occurrences * (tokenCount(phrase) - tokenCount(alias)) - tokenCount(`~L ${alias}=${phrase}\n`);
}

function overlapsAny(ranges: Array<{ start: number; end: number }>, occurrence: Occurrence): boolean {
  return ranges.some((range) => occurrence.start < range.end && occurrence.end > range.start);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
