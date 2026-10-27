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
//   - 旗 `v12.ids` の走り（入力に観測する性質の写像と要る検査の骨組みを渡したとき。Issue #667）は、validate の試験の場所を
//     結び付けと同じ関数（`requiredValidationLocation`）で決める（entity の行の validate も、その entity の名前の検査に写す）。
//     要求する検査が宣言に無い失敗は、骨組みに競合なしで載り・その entity が宣言に在り・同じ名前の検査が宣言のどこにも無く・
//     同じ名前の追加の候補がほかに無いときだけ「追加の場所」（`validation:<entity>.<名前>`）に写す。ほかは今までどおり場所なし
//   - 写せない失敗は「場所なし」として理由つきで別に返す：行の場所が無い（`no-row-location`）・要素が宣言に無い（entity の行の
//     ような置き換えの単位でない場所を含む。`no-element`）・位置が要素の外（`outside-element`）。**推測で近い要素に写さない**
//   - 並びは決定的（失敗の並びの順・場所は最初に現れた順・重複なし）
import { readSpecDocument } from "@musunest/spec-engine";
import type { TestSuite } from "../fixed-test.js";
import type { CorrespondenceMiss, DeclarationLocation, StructuralCheckOutcome } from "../pipeline.js";
import type { RoutedFailure } from "../stages/run-tests.js";
import { requiredValidationLocation, rowLocation, type RequiredValidation } from "../v11a/bind-by-id.js";
import { deriveOwnership, type NameTable, type NameTableGroupBy, type NameTableKind, type NameTableRowType } from "../v11a/names.js";
import type { TestObserves } from "../v11a/stages/test-spec.js";
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

/**
 * 追加の場所 1 つ（旗 `v12.ids` の走りだけ。Issue #667）。validate の試験が要求する（entity・名前）の検査が宣言に無く、コードが
 * 欄だけの直しの本文を validations の節の末尾に挿し込む場所。`key` は `validation:<entity>.<name>`
 */
export interface ValidationAddition {
  readonly key: string;
  readonly entity: string;
  readonly name: string;
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
  /**
   * 追加の場所（`locations` に入った場所のうち、宣言に無い検査を足す場所。最初に現れた順・重複なし）。旗 `v12.ids` の走り
   * （入力に `ids` を渡したとき）だけ持つ（off の結果は今のまま。Issue #667）
   */
  readonly additions?: readonly ValidationAddition[];
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
  /**
   * 旗 `v12.ids` の走りだけ：観測する性質の写像（T2）と、要る検査の骨組み（`requiredValidationsOf`。評価の文脈と同じ組から導いた
   * もの）。渡せば validate の試験の場所を結び付けと同じ関数で決め、追加の場所を作る（Issue #667）
   */
  readonly ids?: {
    readonly observes: ReadonlyMap<string, TestObserves>;
    readonly requiredValidations: readonly RequiredValidation[];
  };
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
    // 旗 ids の走りは追加の場所の欄を持つ（静的チェックに落ちた版は追加を作らない）
    return input.ids === undefined ? finish(located, unlocated, spans) : { ...finish(located, unlocated, spans), additions: [] };
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
  const additionOf = additionCandidates(input, read.ok ? read.document : null, spans);
  const additions: ValidationAddition[] = [];
  const testResolution = (testId: string): Resolution => {
    const test = input.suite.tests.find((candidate) => candidate.id === testId);
    const roleId = test?.target.roleId;
    const base = roleId === undefined ? undefined : rowLocation(input.table, roleId);
    if (test === undefined || base === undefined) return { ok: false, reason: "no-row-location" };
    if (input.ids !== undefined && test.operation === "validate") {
      // 旗 ids：要求する検査の場所は結び付けと同じ関数で決める（entity の行は、その entity の名前の検査）。在れば置換の場所、
      // 無ければ追加の候補（条件を満たすものだけ）、どちらでもなければ場所なし（推測しない）
      const required = requiredValidationLocation(input.table, test);
      if (required === undefined) return { ok: false, reason: "no-element" };
      const replace = resolveLocation(spans, required);
      if (replace.ok) return replace;
      const addition = additionOf.get(test.id);
      if (addition === undefined) return { ok: false, reason: "no-element" };
      if (!additions.some((entry) => entry.key === addition.key)) additions.push(addition);
      return { ok: true, keys: [addition.key] };
    }
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
  const result = finish(located, unlocated, spans);
  return input.ids === undefined ? result : { ...result, additions };
}

/**
 * 追加の候補（試験 ID → 追加の場所。旗 ids の走りだけ。純粋）。B4 の不一致・未解決の validate の試験のうち、次を全部満たすもの：
 *   (i) 観測する性質が validation で、骨組みに競合なしで載る（同じ（entity・名前）・同じ試験 ID）
 *   (ii)(iv) 同じ名前の検査が宣言のどの entity にも無い（検査の名前は宣言全体で一意）
 *   (iii) その entity が宣言に在る
 *   (v) 同じ名前の追加の候補がほかの（entity）に無い（衝突する候補は全部外す。どちらも選ばない）
 * 静的チェックに落ちた版・読めない宣言には作らない。
 */
function additionCandidates(
  input: LocateInput,
  document: Record<string, unknown> | null,
  spans: readonly DeclarationSpan[],
): ReadonlyMap<string, ValidationAddition> {
  const candidates = new Map<string, ValidationAddition>();
  const ids = input.ids;
  if (ids === undefined || document === null || !input.staticCheckPassed) return candidates;
  const namesOf = (section: string): readonly string[] => {
    const values = document[section];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value: unknown) => (isRecord(value) && typeof value["name"] === "string" ? [value["name"]] : []));
  };
  // 中身のある流れの書き方の検査の節（`validations: [ … ]`）には挿し込めないので、追加の場所を作らない（場所なしのまま
  // 今までの経路へ戻す。走りを止めない）。候補にするのは並びの節と `validations: []` だけ（節が無い宣言・中身のある流れの
  // 書き方は静的チェックに落ちるので、走りの中ではここへ来ない。純粋な入力でも挿し込みの断りで往復を消費させない）
  const validationsValue = document["validations"];
  const blockHeader = input.source.split("\n").some((line) => /^validations:\s*(#.*)?$/.test(line));
  const emptyFlow = input.source.split("\n").some((line) => /^validations:\s*\[\s*\]\s*(#.*)?$/.test(line));
  if (!blockHeader && !emptyFlow) return candidates;
  if (Array.isArray(validationsValue) && validationsValue.length > 0 && !blockHeader) return candidates;
  const validationNames = new Set(namesOf("validations"));
  const entityNames = new Set(namesOf("entities"));
  const testIds = [...input.mismatches, ...input.unresolved].map((entry) => entry.testId);
  for (const testId of testIds) {
    if (candidates.has(testId)) continue;
    const test = input.suite.tests.find((candidate) => candidate.id === testId);
    if (test === undefined || test.operation !== "validate" || ids.observes.get(testId) !== "validation") continue;
    const required = requiredValidationLocation(input.table, test);
    if (required === undefined || required.entity === null) continue;
    const entry = ids.requiredValidations.find(
      (candidate) => candidate.entity === required.entity && candidate.name === required.name && candidate.testIds.includes(testId),
    );
    if (entry === undefined || entry.conflict) continue;
    if (spanOf(spans, required) !== undefined) continue;
    if (validationNames.has(required.name) || !entityNames.has(required.entity)) continue;
    candidates.set(testId, { key: spanKey("validation", required.entity, required.name), entity: required.entity, name: required.name });
  }
  // (v) 同じ名前で（entity）の違う候補は全部外す
  const entitiesByName = new Map<string, Set<string>>();
  for (const candidate of candidates.values()) {
    const entities = entitiesByName.get(candidate.name) ?? new Set<string>();
    entities.add(candidate.entity);
    entitiesByName.set(candidate.name, entities);
  }
  return new Map([...candidates].filter(([, candidate]) => (entitiesByName.get(candidate.name)?.size ?? 0) <= 1));
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

/** 欄だけの直しを使えるか（場所に写した失敗が 1 つ以上あり、場所なしが 0。追加の場所は場所に写した側に数える） */
export function canRepairFields(locations: FailureLocations): boolean {
  return locations.located.length > 0 && locations.unlocated.length === 0 && locations.locations.length > 0;
}

// ── 修復へ渡す診断（旗 `v12.ids` と探索がともに on の走りだけ。Issue #761）────────────────────
//
// 失敗を検出する側（C7 の試験・B3 の対応・B3' の点検）が持つ情報を、欄だけの直しと探索 on の全文の直しへ渡す。**純粋な関数**で、
// 材料は一番良い版の状態と評価の入力・結果だけ（新しい評価をしない）。**構造化した actual は作らない**——`detail` は評価の返り値
// のまま写し、文を解析しない・expected から補わない。試験の無い要件・未実施・参照の欠けで、ID や結果を作らない。

/** 表に無い ID の参照材料を省いた印（固定文。型や所属を推測しない） */
export const REPAIR_DIAGNOSTIC_OMITTED = "表にこの ID が無いため省いた";

/** 診断の表の行（B1 の射影と同じ欄。所属・参照先・見出しの元の ID は表の実名へ引く） */
export interface RepairDiagnosticRow {
  readonly id: string;
  readonly kind: NameTableKind;
  readonly entity: string | null;
  readonly name: string;
  readonly type: NameTableRowType;
  readonly options: readonly string[] | null;
  readonly groupBy: NameTableGroupBy;
  readonly refEntity: string | null;
  readonly role: string;
}

/** C7（不一致・未解決）の試験 1 件の診断（試験 ID ごとに 1 件） */
export interface RepairDiagnosticTest {
  readonly testId: string;
  /** 固定した試験から引いた要件 ID（試験が無ければ null） */
  readonly requirementId: string | null;
  /** 固定した試験の対象の行 ID（試験が無い・欄が無ければ null） */
  readonly roleId: string | null;
  /** その試験の観測する性質（写像に無ければ null） */
  readonly observes: TestObserves | null;
  /** 表の行（引けなければ null。`omitted` に固定の印） */
  readonly table: RepairDiagnosticRow | null;
  /** 参照材料を省いた印（省いていなければ null） */
  readonly omitted: string | null;
  /**
   * 評価の返り値の `detail` を、不一致→未解決の順にそのまま並べる（同じ試験 ID が不一致と未解決の両方に出れば両方を持つ。
   * 解析・再評価しない）
   */
  readonly details: readonly string[];
  /** 経路（`routes` の該当の試験 ID。無ければ空の並び） */
  readonly routes: readonly RoutedFailure[];
  /** 構造の違い（`structural` の該当のうち、成り立たなかったもの。無ければ空の並び） */
  readonly structural: readonly StructuralCheckOutcome[];
}

/** B3（対応の落ち）1 件（`location` の無い落ちもそのまま持つ） */
export interface RepairDiagnosticMiss {
  readonly requirementId: string;
  readonly location: DeclarationLocation | null;
  readonly detail: string;
}

/** B3'（拒否）1 件（種類と引用をそのまま。原文の全文は入れない） */
export interface RepairDiagnosticRejection {
  readonly requirementId: string;
  readonly kind: string;
  readonly quote: string;
}

/** 要件 ID ごとの B3 の落ち（要件の並びは最初に現れた順。落ちは全件） */
export interface RepairDiagnosticRequirementMisses {
  readonly requirementId: string;
  readonly misses: readonly RepairDiagnosticMiss[];
}

/** 要件 ID ごとの B3' の拒否（試験を持たない拒否も要件 ID で結ぶ） */
export interface RepairDiagnosticRequirementRejections {
  readonly requirementId: string;
  readonly rejections: readonly RepairDiagnosticRejection[];
}

/**
 * 修復へ渡す、一番良い版の失敗の診断（C7・B3・B3' を結び付けた形）。**独立の型**であり、`NamedFailure`・`LocatedFailure`・
 * 失敗集合の指紋・探索の記録・評価結果の型を変えない。
 */
export interface RepairDiagnostic {
  readonly tests: readonly RepairDiagnosticTest[];
  readonly correspondence: readonly RepairDiagnosticRequirementMisses[];
  readonly rejections: readonly RepairDiagnosticRequirementRejections[];
}

/**
 * 診断の材料（run.ts が持つ一番良い版の状態と評価の入力・結果）。**新しい評価をしない**——渡された値を写すだけ。
 */
export interface RepairDiagnosticInput {
  /** 名前の表（表の行と、所属・参照先・見出しの元の実名を引く） */
  readonly table: NameTable;
  /** 今の固定した試験（要件 ID と対象の行 ID を引く） */
  readonly suite: TestSuite;
  /** 観測する性質の写像（T2） */
  readonly observes: ReadonlyMap<string, TestObserves>;
  readonly mismatches: readonly { readonly testId: string; readonly detail: string }[];
  readonly unresolved: readonly { readonly testId: string; readonly detail: string }[];
  readonly correspondenceMisses: readonly CorrespondenceMiss[];
  readonly rejections: readonly { readonly requirementId: string; readonly kind: string; readonly quote: string }[];
  /** 失敗の経路（`best.report.routes`） */
  readonly routes: readonly RoutedFailure[];
  /** 構造の検査の 1 件ごとの記録（`best.report.testRun.structural`。無ければ空） */
  readonly structural?: readonly StructuralCheckOutcome[];
}

/** 表の行の ID から宣言の名前を引く（見つからなければ undefined） */
const tableName = (table: NameTable, id: string): string | undefined => table.rows.find((row) => row.id === id)?.name;

/**
 * 試験の対象の行 ID から、診断の表の行を組む（B1 の射影と同じ欄・実名）。行が無い・所属や参照先や見出しの元の ID が表に無いときは
 * 行を省き、固定の印を返す（型や所属を推測しない）。
 */
function diagnosticRowOf(
  table: NameTable,
  roleId: string | undefined,
): { readonly row: RepairDiagnosticRow | null; readonly omitted: string | null } {
  if (roleId === undefined) return { row: null, omitted: null };
  const row = table.rows.find((candidate) => candidate.id === roleId);
  if (row === undefined) return { row: null, omitted: REPAIR_DIAGNOSTIC_OMITTED };
  const entity = row.entity === null ? null : tableName(table, row.entity);
  const refEntity = row.refEntity === null ? null : tableName(table, row.refEntity);
  const groupByName = row.groupBy === null ? null : tableName(table, row.groupBy.field);
  if (
    (row.entity !== null && entity === undefined) ||
    (row.refEntity !== null && refEntity === undefined) ||
    (row.groupBy !== null && groupByName === undefined)
  ) {
    return { row: null, omitted: REPAIR_DIAGNOSTIC_OMITTED };
  }
  return {
    row: {
      id: row.id,
      kind: row.kind,
      entity: entity ?? null,
      name: row.name,
      type: row.type,
      options: row.options,
      groupBy: row.groupBy === null ? null : { kind: row.groupBy.kind, field: groupByName as string },
      refEntity: refEntity ?? null,
      role: row.role,
    },
    omitted: null,
  };
}

/**
 * 一番良い版の失敗の診断を組む（純粋。同じ入力なら同じ結果）。C7 は試験 ID ごとに 1 件（不一致・未解決の順）、B3 は要件 ID ごとに
 * 落ちを全件、B3' は要件 ID ごとに拒否を全件。`details`・引用は渡された値のままで、構造化した actual を作らない。
 */
export function buildRepairDiagnostic(input: RepairDiagnosticInput): RepairDiagnostic {
  const testById = new Map(input.suite.tests.map((test) => [test.id, test] as const));
  const structural = input.structural ?? [];
  // 試験 ID ごとに 1 件。detail は不一致→未解決の順に全部残す（同じ試験 ID が両方に出ても後の detail を捨てない）
  const testIds: string[] = [];
  const detailsById = new Map<string, string[]>();
  for (const failure of [...input.mismatches, ...input.unresolved]) {
    const details = detailsById.get(failure.testId);
    if (details === undefined) {
      detailsById.set(failure.testId, [failure.detail]);
      testIds.push(failure.testId);
    } else {
      details.push(failure.detail);
    }
  }
  const tests: RepairDiagnosticTest[] = testIds.map((testId) => {
    const test = testById.get(testId);
    const roleId = test?.target.roleId;
    const row = diagnosticRowOf(input.table, roleId);
    return {
      testId,
      requirementId: test?.target.requirementId ?? null,
      roleId: roleId ?? null,
      observes: input.observes.get(testId) ?? null,
      table: row.row,
      omitted: row.omitted,
      details: detailsById.get(testId) ?? [],
      routes: input.routes.filter((route) => route.testId === testId),
      structural: structural.filter((entry) => entry.testId === testId && entry.result !== "pass"),
    };
  });
  const missesByRequirement = new Map<string, RepairDiagnosticMiss[]>();
  for (const miss of input.correspondenceMisses) {
    const misses = missesByRequirement.get(miss.requirementId) ?? [];
    misses.push({ requirementId: miss.requirementId, location: miss.location ?? null, detail: miss.detail });
    missesByRequirement.set(miss.requirementId, misses);
  }
  const rejectionsByRequirement = new Map<string, RepairDiagnosticRejection[]>();
  for (const rejection of input.rejections) {
    const rejections = rejectionsByRequirement.get(rejection.requirementId) ?? [];
    rejections.push({ requirementId: rejection.requirementId, kind: rejection.kind, quote: rejection.quote });
    rejectionsByRequirement.set(rejection.requirementId, rejections);
  }
  return {
    tests,
    correspondence: [...missesByRequirement].map(([requirementId, misses]) => ({ requirementId, misses })),
    rejections: [...rejectionsByRequirement].map(([requirementId, rejections]) => ({ requirementId, rejections })),
  };
}
