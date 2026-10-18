// 失敗の場所（08-architecture-v1.2.md §3 の決定 1 (c)「失敗した欄だけを直す」・§4 のループの行・§9 の手 4 の後半。Issue #553）。
//
// 旗 `v12.search-repair` の直す手を「門が名前を付けた失敗の欄だけを置き換える」段（`v12/stages/field-repair.ts`）にするため、
// 一番良い版の名前付きの失敗を、宣言の要素（entity の項目・計算・操作・検査・画面の 1 つ）の場所に写す。**純粋な関数だけ**を置き、
// LLM・評価口・段を呼ばない。
//
//   - 宣言の要素の行の範囲（`declarationSpans`）：spec-engine の読み取り（`readSpecDocument`）で読めた宣言だけ、節（entities・
//     validations・computed・actions・views）の並びの要素と、entity の `fields` の項目を、原文の行の範囲に決定的に対応させる。
//     読み取りの値（要素の数・名前・項目の順）と行の数え方が合わない節は範囲を出さない（推測で範囲を決めない）
//   - 場所（`locateFailures`）：B4 の不一致・未解決は試験の対象の行 ID から、B3 の結び付けの落ちはその落ちの場所（表の行から
//     引いた場所）から、B3' の拒否は要件が所属させた行（導いた entity の所属を含む）から、名前の表の行の場所の関数（`rowLocation`）で引く。検査（validate）の
//     試験は、結び付け（`bindTestsById`）と同じく所属 entity の行の名前と同じ名前の検査に写す。静的チェックの問題は、その位置を
//     含む要素に写す
//   - 写せない失敗は「場所なし」として理由つきで別に返す：行の場所が無い（`no-row-location`）・要素が宣言に無い（entity の行の
//     ような置き換えの単位でない場所を含む。`no-element`）・位置が要素の外（`outside-element`）。**推測で近い要素に写さない**
//   - 並びは決定的（失敗の並びの順・場所は最初に現れた順・重複なし）
import { readSpecDocument } from "@musunest/spec-engine";
import type { TestSuite } from "../fixed-test.js";
import type { CorrespondenceMiss, DeclarationLocation } from "../pipeline.js";
import { rowLocation } from "../v11a/bind-by-id.js";
import { deriveOwnership, type NameTable } from "../v11a/names.js";
import { NAMED_FAILURE_MESSAGES, type NamedFailure, type NamedFailureKind } from "./search-repair.js";

// ── 宣言の要素の行の範囲 ─────────────────────────────────────────────

/** 置き換えの単位になる要素の種類（entity そのものは単位にしない＝項目ごとに置き換える） */
export const ELEMENT_KINDS = ["field", "validation", "computation", "action", "view"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** 並びの節 → 要素の種類（entities は項目に分ける） */
const LIST_SECTIONS = [
  ["validations", "validation"],
  ["computed", "computation"],
  ["actions", "action"],
  ["views", "view"],
] as const;
export type ListSection = (typeof LIST_SECTIONS)[number][0];

/** 要素が読み取りの値のどこにあるか（節の並びの添字。項目は entity の添字と項目の名前） */
export type ElementSlot =
  | { readonly section: ListSection; readonly index: number }
  | { readonly section: "entities"; readonly index: number; readonly field: string };

/** 宣言の要素 1 つの、原文の行の範囲 */
export interface DeclarationSpan {
  /** 場所の名前（コードが組む。`field:<entity>.<name>`・`<kind>:<name>`・entity を持つ要素は `<kind>:<entity>.<name>`） */
  readonly key: string;
  readonly kind: ElementKind;
  readonly entity: string | null;
  readonly name: string;
  /** 範囲の最初の行（0 始まり。含む） */
  readonly start: number;
  /** 範囲の終わり（0 始まり。含まない。末尾の空行・コメントだけの行は含めない） */
  readonly end: number;
  /** 範囲の最初の行の字下げ（並びの要素は `-` の位置、項目は名前の位置） */
  readonly indent: number;
  readonly slot: ElementSlot;
}

/** 範囲を決めた結果（読めない宣言は `ok: false`。要素ごとの範囲を出せない節の要素は入らない） */
export type DeclarationSpans =
  | { readonly ok: true; readonly document: Record<string, unknown>; readonly spans: readonly DeclarationSpan[] }
  | { readonly ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 中身のある行か（空行とコメントだけの行を除く） */
const isContent = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#");
};
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** 場所の名前（決定的） */
export function spanKey(kind: ElementKind, entity: string | null, name: string): string {
  return entity === null ? `${kind}:${name}` : `${kind}:${entity}.${name}`;
}

/** 範囲の末尾から、空行とコメントだけの行を外す（最初の行は残す） */
function trimmedEnd(lines: readonly string[], start: number, end: number): number {
  let last = end;
  while (last > start + 1 && !isContent(lines[last - 1] ?? "")) last -= 1;
  return last;
}

/** 最上位の欄の行（字下げ 0 の `<name>:`。値を同じ行に書いた節＝流れの書き方は範囲を出さない） */
function sectionHeader(lines: readonly string[], section: string): number {
  const pattern = new RegExp(`^${section}:\\s*(#.*)?$`);
  return lines.findIndex((line) => pattern.test(line));
}

/** 節の終わり（次の最上位の欄の行。無ければ末尾） */
function sectionEnd(lines: readonly string[], header: number): number {
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isContent(line) && indentOf(line) === 0) return index;
  }
  return lines.length;
}

/** 節の並びの要素の最初の行（`-` の行）。読み取りの値と数え方が合わなければ null */
function itemStarts(lines: readonly string[], header: number, end: number): readonly number[] | null {
  const starts: number[] = [];
  let itemIndent: number | null = null;
  for (let index = header + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (!isContent(line)) continue;
    const indent = indentOf(line);
    if (itemIndent === null) itemIndent = indent;
    if (indent < itemIndent) return null;
    if (indent === itemIndent) {
      if (!/^\s*-(\s|$)/.test(line)) return null;
      starts.push(index);
    }
  }
  return starts;
}

/** 並びの要素の欄の字下げ（`- name: x` なら name の位置、`-` だけの行なら次の中身の行の字下げ） */
function itemKeyIndent(lines: readonly string[], start: number, end: number): number | null {
  const line = lines[start] ?? "";
  const match = /^(\s*)-(\s+)(\S.*)?$/.exec(line);
  if (match !== null && match[3] !== undefined) return (match[1] ?? "").length + 1 + (match[2] ?? "").length;
  for (let index = start + 1; index < end; index += 1) {
    const next = lines[index] ?? "";
    if (isContent(next)) return indentOf(next);
  }
  return null;
}

/** entity の要素の範囲から、`fields` の項目ごとの範囲を出す（数え方が読み取りの値と合わなければ空） */
function fieldSpans(
  lines: readonly string[],
  start: number,
  end: number,
  entityIndex: number,
  entity: Record<string, unknown>,
  entityName: string,
): readonly DeclarationSpan[] {
  const fields = entity["fields"];
  if (!isRecord(fields)) return [];
  const names = Object.keys(fields);
  if (names.length === 0) return [];
  const keyIndent = itemKeyIndent(lines, start, end);
  if (keyIndent === null) return [];
  let header = -1;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (isContent(line) && indentOf(line) === keyIndent && /^\s*fields:\s*(#.*)?$/.test(line)) {
      header = index;
      break;
    }
  }
  if (header < 0) return [];
  let fieldsEnd = end;
  for (let index = header + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (isContent(line) && indentOf(line) <= keyIndent) {
      fieldsEnd = index;
      break;
    }
  }
  const starts: { readonly index: number; readonly name: string }[] = [];
  let fieldIndent: number | null = null;
  for (let index = header + 1; index < fieldsEnd; index += 1) {
    const line = lines[index] ?? "";
    if (!isContent(line)) continue;
    const indent = indentOf(line);
    if (fieldIndent === null) fieldIndent = indent;
    if (indent < fieldIndent) return [];
    if (indent === fieldIndent) {
      const match = /^\s*([^\s#:'"-][^:]*):(\s|$)/.exec(line);
      if (match === null) return [];
      starts.push({ index, name: (match[1] ?? "").trim() });
    }
  }
  if (starts.length !== names.length || starts.some((entry, index) => entry.name !== names[index])) return [];
  return starts.map((entry, index) => ({
    key: spanKey("field", entityName, entry.name),
    kind: "field" as const,
    entity: entityName,
    name: entry.name,
    start: entry.index,
    end: trimmedEnd(lines, entry.index, starts[index + 1]?.index ?? fieldsEnd),
    indent: fieldIndent ?? 0,
    slot: { section: "entities" as const, index: entityIndex, field: entry.name },
  }));
}

/**
 * 宣言の要素の行の範囲を、決まった順（entity の項目・検査・計算・操作・画面）で出す（純粋）。読めない宣言は `ok: false`。
 * 節の行の数え方（字下げ・`-` の行の数・項目の名前と順）が読み取りの値と合わない節の要素は出さない（場所なしになる）。
 */
export function declarationSpans(source: string): DeclarationSpans {
  const read = readSpecDocument(source);
  if (!read.ok || !isRecord(read.document)) return { ok: false };
  const document = read.document;
  const lines = source.split("\n");
  const spans: DeclarationSpan[] = [];
  const itemsOf = (section: string): { readonly values: readonly unknown[]; readonly starts: readonly number[]; readonly end: number } | null => {
    const values = document[section];
    if (!Array.isArray(values) || values.length === 0) return null;
    const header = sectionHeader(lines, section);
    if (header < 0) return null;
    const end = sectionEnd(lines, header);
    const starts = itemStarts(lines, header, end);
    if (starts === null || starts.length !== values.length) return null;
    return { values, starts, end };
  };
  const entities = itemsOf("entities");
  if (entities !== null) {
    entities.values.forEach((value, index) => {
      const start = entities.starts[index] ?? 0;
      const end = trimmedEnd(lines, start, entities.starts[index + 1] ?? entities.end);
      if (!isRecord(value) || typeof value["name"] !== "string") return;
      spans.push(...fieldSpans(lines, start, end, index, value, value["name"]));
    });
  }
  for (const [section, kind] of LIST_SECTIONS) {
    const items = itemsOf(section);
    if (items === null) continue;
    items.values.forEach((value, index) => {
      if (!isRecord(value) || typeof value["name"] !== "string") return;
      const start = items.starts[index] ?? 0;
      const entity = typeof value["entity"] === "string" ? value["entity"] : null;
      spans.push({
        key: spanKey(kind, entity, value["name"]),
        kind,
        entity,
        name: value["name"],
        start,
        end: trimmedEnd(lines, start, items.starts[index + 1] ?? items.end),
        indent: indentOf(lines[start] ?? ""),
        slot: { section, index },
      });
    });
  }
  return { ok: true, document, spans };
}

/**
 * 宣言の場所に当たる要素の範囲（ちょうど 1 つのときだけ。場所の名前が重なる要素は返さない）。entity は置き換えの単位でないので
 * 返さない。画面は名前だけで引く（結び付けと同じ）。ほかは場所が entity を持てば同じ entity の要素だけ。
 */
export function spanOf(spans: readonly DeclarationSpan[], location: DeclarationLocation): DeclarationSpan | undefined {
  if (location.kind === "entity") return undefined;
  const kind: ElementKind = location.kind;
  const candidates = spans.filter(
    (span) =>
      span.kind === kind &&
      span.name === location.name &&
      (kind === "field" ? span.entity === location.entity : kind === "view" || location.entity === null || span.entity === location.entity),
  );
  if (candidates.length !== 1) return undefined;
  const found = candidates[0];
  if (found === undefined || spans.filter((span) => span.key === found.key).length !== 1) return undefined;
  return found;
}

// ── 失敗の場所 ───────────────────────────────────────────────────

/** 場所なしの理由（行の場所が無い・要素が宣言に無い・位置が要素の外） */
export const UNLOCATED_REASONS = ["no-row-location", "no-element", "outside-element"] as const;
export type UnlocatedReason = (typeof UNLOCATED_REASONS)[number];

/** 場所に写した失敗（名前付きの失敗に、場所の名前の並びを足したもの） */
export interface LocatedFailure extends NamedFailure {
  readonly locations: readonly string[];
}

/** 場所なしの失敗（名前付きの失敗に、理由を足したもの） */
export interface UnlocatedFailure extends NamedFailure {
  readonly reason: UnlocatedReason;
}

/** 失敗の場所の結果 */
export interface FailureLocations {
  /** 場所に写した失敗（失敗の並びの順） */
  readonly located: readonly LocatedFailure[];
  /** 場所なしの失敗（失敗の並びの順） */
  readonly unlocated: readonly UnlocatedFailure[];
  /** 場所の名前（最初に現れた順・重複なし）。直す段の場所の選択肢（enum）になる */
  readonly locations: readonly string[];
  /** 一番良い版の要素の範囲（読めない宣言は空） */
  readonly spans: readonly DeclarationSpan[];
}

/** 一番良い版に残った失敗（`namedFailuresOf` の入力に、場所を引くための材料を足したもの） */
export interface LocateInput {
  /** 一番良い版の宣言の原文 */
  readonly source: string;
  /** 名前の表（行の場所を引く） */
  readonly table: NameTable;
  /** 固定した試験（試験の対象の行 ID を引く） */
  readonly suite: TestSuite;
  readonly staticCheckPassed: boolean;
  /** 静的チェックの問題の位置（1 始まりの行） */
  readonly diagnostics: readonly { readonly line: number }[];
  readonly correspondenceMisses: readonly CorrespondenceMiss[];
  readonly rejections: readonly { readonly requirementId: string }[];
  readonly unmarked: readonly string[];
  readonly mismatches: readonly { readonly testId: string }[];
  readonly unresolved: readonly { readonly testId: string }[];
}

type Resolution = { readonly ok: true; readonly keys: readonly string[] } | { readonly ok: false; readonly reason: UnlocatedReason };

/** 表の行の場所を要素へ写す（行の場所が無い・置き換えの単位でない・宣言に無いは場所なし） */
function resolveLocation(spans: readonly DeclarationSpan[], location: DeclarationLocation | undefined): Resolution {
  if (location === undefined) return { ok: false, reason: "no-row-location" };
  const span = spanOf(spans, location);
  return span === undefined ? { ok: false, reason: "no-element" } : { ok: true, keys: [span.key] };
}

/**
 * 一番良い版の名前付きの失敗を、宣言の要素の場所に写す（純粋。同じ入力なら同じ結果）。失敗の並びは `namedFailuresOf` と同じ
 * 種類の順（静的チェックに落ちた版は静的チェックの問題だけ）。同じ失敗（種類・試験 ID・要件 ID・場所が同じ）は 1 つにする。
 */
export function locateFailures(input: LocateInput): FailureLocations {
  const read = declarationSpans(input.source);
  const spans = read.ok ? read.spans : [];
  const located: LocatedFailure[] = [];
  const unlocated: UnlocatedFailure[] = [];
  const seen = new Set<string>();
  const requirementOfTest = (testId: string): string | null =>
    input.suite.tests.find((test) => test.id === testId)?.target.requirementId ?? null;
  const push = (kind: NamedFailureKind, testId: string | null, requirementId: string | null, resolution: Resolution): void => {
    const base: NamedFailure = { testId, requirementId, kind, message: NAMED_FAILURE_MESSAGES[kind] };
    const id = JSON.stringify([kind, testId, requirementId, resolution.ok ? resolution.keys : resolution.reason]);
    if (seen.has(id)) return;
    seen.add(id);
    if (resolution.ok) located.push({ ...base, locations: resolution.keys });
    else unlocated.push({ ...base, reason: resolution.reason });
  };

  if (!input.staticCheckPassed) {
    if (input.diagnostics.length === 0) push("static-check", null, null, { ok: false, reason: "outside-element" });
    for (const diagnostic of input.diagnostics) {
      const line = diagnostic.line - 1;
      const containing = spans.filter((span) => span.start <= line && line < span.end);
      const span = containing.length === 1 ? containing[0] : undefined;
      push("static-check", null, null, span === undefined ? { ok: false, reason: "outside-element" } : { ok: true, keys: [span.key] });
    }
    return finish(located, unlocated, spans);
  }

  for (const miss of input.correspondenceMisses) {
    push("correspondence-miss", null, miss.requirementId, resolveLocation(spans, miss.location));
  }
  for (const rejection of input.rejections) {
    // 所属は導いた entity の所属を含む（`deriveOwnership`。B3・持ち越しと同じ所属）。entity の行を含む拒否は、項目の足し引きの
    // ような entity の単位の直しが要りうるので、置き換えの単位に写さない（場所なし）
    const roles = deriveOwnership(input.table).find((entry) => entry.requirementId === rejection.requirementId)?.roles ?? [];
    let resolution: Resolution = roles.length === 0 ? { ok: false, reason: "no-row-location" } : { ok: true, keys: [] };
    for (const role of roles) {
      if (!resolution.ok) break;
      const one = resolveLocation(spans, rowLocation(input.table, role.id));
      resolution = one.ok ? { ok: true, keys: [...new Set([...resolution.keys, ...one.keys])] } : one;
    }
    push("decl-rejection", null, rejection.requirementId, resolution);
  }
  for (const requirementId of input.unmarked) push("decl-unmarked", null, requirementId, { ok: false, reason: "no-element" });
  const testResolution = (testId: string): Resolution => {
    const test = input.suite.tests.find((candidate) => candidate.id === testId);
    const roleId = test?.target.roleId;
    const base = roleId === undefined ? undefined : rowLocation(input.table, roleId);
    if (test === undefined || base === undefined) return { ok: false, reason: "no-row-location" };
    if (base.kind === "entity") return { ok: false, reason: "no-element" };
    // 検査（validate）の試験は、結び付けと同じく所属 entity の行の名前と同じ名前の検査に写す（M-03）
    const location: DeclarationLocation = test.operation === "validate" ? { kind: "validation", entity: base.entity, name: base.name } : base;
    return resolveLocation(spans, location);
  };
  for (const mismatch of input.mismatches) {
    push("test-mismatch", mismatch.testId, requirementOfTest(mismatch.testId), testResolution(mismatch.testId));
  }
  for (const entry of input.unresolved) {
    push("test-unresolved", entry.testId, requirementOfTest(entry.testId), testResolution(entry.testId));
  }
  return finish(located, unlocated, spans);
}

function finish(
  located: readonly LocatedFailure[],
  unlocated: readonly UnlocatedFailure[],
  spans: readonly DeclarationSpan[],
): FailureLocations {
  const locations: string[] = [];
  for (const failure of located) for (const key of failure.locations) if (!locations.includes(key)) locations.push(key);
  return { located, unlocated, locations, spans };
}

/** 欄だけの直しを使えるか（場所に写した失敗が 1 つ以上あり、場所なしが 0） */
export function canRepairFields(locations: FailureLocations): boolean {
  return locations.located.length > 0 && locations.unlocated.length === 0 && locations.locations.length > 0;
}
