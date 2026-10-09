// ⑤a 対応表（02-architecture.md §1・F-2・F-8・R-1）。
//
// **原文・要件の一覧・宣言**を渡した別の会話で、要件ごとに、満たす宣言の場所（要素）を挙げさせる。
// そのうえで**コードが**次を確かめる（会話の申告だけに頼らない。§1）：
//
//   - 挙げた名前が宣言に実在するか
//   - 計算は、画面（view の `show`・ダッシュボードの部品・`show` を省略して全部を出す一覧）から
//     辿れるか
//
// 落ち（実在しない・画面から辿れない）は ⑦ の入力（対応表の落ち）になる。合否はここでは決めない。
import {
  isAppComputed,
  isComputedSettle,
  isGroupComputed,
  type Computed,
  type Entity,
  type NormalizedAppSpec,
  type View,
} from "@musunest/appspec-schema";
import type { CallGateway } from "../call.js";
import {
  DECLARATION_LOCATION_KINDS,
  type CorrespondenceEntry,
  type CorrespondenceMiss,
  type CorrespondenceResult,
  type Declaration,
  type DeclarationLocation,
  type RequirementList,
} from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ⑤a の JSON Schema の名前 */
export const CORRESPONDENCE_SCHEMA_NAME = "requirement-correspondence";

/** ⑤a に足す規則（共通の規則は buildStructuredRequest が先頭に付ける） */
export const CORRESPONDENCE_RULES: readonly string[] = [
  "あなたは、作った宣言を、原文と要件の一覧に戻って点検する役である。",
  "要件ごとに、その要件を満たす宣言の中の場所（要素）を挙げる。",
  "場所は種類（kind）・名前（name）・それを載せている entity の名前（entity）で指す。",
  "kind は entity・field・validation・computation・action・view のいずれかである。entity 自身のとき、entity は null にする。",
  "宣言に実在する名前だけを挙げる。画面から辿れない計算は挙げない。",
  "要件ごとに 1 つの項目を返す。要件 ID は一覧のまま写す。",
];

/** ⑤a の JSON Schema（構造化出力） */
export const CORRESPONDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "locations"],
        properties: {
          requirementId: { type: "string", description: "要件の識別子（一覧のまま）" },
          locations: {
            type: "array",
            description: "その要件を満たす宣言の中の場所",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "entity", "name"],
              properties: {
                kind: { type: "string", enum: [...DECLARATION_LOCATION_KINDS] },
                entity: { type: ["string", "null"], description: "載っている entity の名前（entity 自身のときは null）" },
                name: { type: "string", description: "宣言の中の名前" },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** ⑤a が受け取るもの（原文・要件の一覧・宣言。§1） */
export interface CorrespondenceInput {
  /** 依頼文（原文）。**必ず渡す**（R-1） */
  readonly source: string;
  readonly list: RequirementList;
  /** 宣言（書いた原文）。会話には原文をそのまま渡す */
  readonly declaration: Declaration;
  /** 検査済みの宣言（正規化した JSON）。実在と到達の確認はコードがこれで行う */
  readonly app: NormalizedAppSpec;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
}

/** 場所の形を確かめる */
function checkLocationShape(value: unknown, field: string, problems: Problem[]): DeclarationLocation | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "場所は写像（object）であること" });
    return undefined;
  }
  const kind = value["kind"];
  const validKind =
    typeof kind === "string" && (DECLARATION_LOCATION_KINDS as readonly string[]).includes(kind);
  if (!validKind) {
    problems.push({ field: `${field}.kind`, message: `種類は ${DECLARATION_LOCATION_KINDS.join("・")} のいずれかであること` });
  }
  const entity = value["entity"];
  const entityOk = entity === null || (typeof entity === "string" && entity !== "");
  if (!entityOk) {
    problems.push({ field: `${field}.entity`, message: "entity は空でない文字列か null であること" });
  }
  const name = value["name"];
  if (typeof name !== "string" || name === "") {
    problems.push({ field: `${field}.name`, message: "名前は空でない文字列であること" });
  }
  if (!validKind || !entityOk || typeof name !== "string" || name === "") return undefined;
  return {
    kind: kind as DeclarationLocation["kind"],
    entity: (entity as string | null) ?? null,
    name,
  };
}

/** ⑤a の応答の形を確かめる */
export function checkCorrespondenceOutput(output: unknown): ShapeCheck<{ entries: readonly CorrespondenceEntry[] }> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const raw = output["entries"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "entries", message: "対応表は並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  const entries: CorrespondenceEntry[] = [];
  raw.forEach((item, index) => {
    const field = `entries[${index}]`;
    if (!isRecord(item)) {
      problems.push({ field, message: "対応表の項目は写像（object）であること" });
      return;
    }
    const requirementId = item["requirementId"];
    if (typeof requirementId !== "string" || requirementId === "") {
      problems.push({ field: `${field}.requirementId`, message: "要件 ID は空でない文字列であること" });
    }
    const rawLocations = item["locations"];
    if (!Array.isArray(rawLocations)) {
      problems.push({ field: `${field}.locations`, message: "場所の並び（array）であること" });
      return;
    }
    const locations: DeclarationLocation[] = [];
    rawLocations.forEach((location, locationIndex) => {
      const checked = checkLocationShape(location, `${field}.locations[${locationIndex}]`, problems);
      if (checked !== undefined) locations.push(checked);
    });
    if (typeof requirementId === "string" && requirementId !== "") {
      entries.push({ requirementId, locations });
    }
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { entries } };
}

// ── コードによる確認（実在・画面からの到達。§1） ────────────────────────

/** 場所の確認の結果 */
export type LocationCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const notFound = (detail: string): LocationCheck => ({ ok: false, reason: detail });

/** 名前で entity を引く */
export function findEntity(app: NormalizedAppSpec, name: string | null): Entity | undefined {
  return app.spec.entities.find((entity) => entity.name === name);
}

/** 場所が指す計算を引く（名前と、載っている entity で照合する） */
export function findComputed(app: NormalizedAppSpec, location: DeclarationLocation): Computed | undefined {
  return app.spec.computed.find(
    (computed) =>
      computed.name === location.name &&
      (location.entity === null || ("entity" in computed && computed.entity === location.entity)),
  );
}

/**
 * `show` を書かない一覧（種類なし・`table`・`list`）は、項目（宣言の順）に続いて計算（宣言の順）を
 * **全部**出す（後ろの注記と同じ意味）。だから、その entity の計算は画面から辿れる。
 */
function viewShowsEverything(view: View, entity: string): boolean {
  if (view.entity !== entity || view.show !== undefined) return false;
  return view.type === undefined || view.type === "table" || view.type === "list";
}

/** ダッシュボードの順位の部品が、その計算を行として出しているか */
function rankingShows(view: View, entity: string, name: string): boolean {
  if (view.type !== "dashboard") return false;
  return (view.widgets ?? []).some(
    (part) =>
      part.type === "ranking" &&
      part.entity === entity &&
      (part.by === name || part.show.includes(name)),
  );
}

/** 行ごとの計算が、画面（一覧の `show`・`show` の省略・ボードの強調・順位の部品）から辿れるか */
function rowComputedReachable(app: NormalizedAppSpec, entity: string, name: string): boolean {
  return app.spec.views.some((view) => {
    if (view.type === "board" && view.entity === entity) return view.highlight === name;
    if (view.entity === entity && view.show !== undefined) return view.show.includes(name);
    return viewShowsEverything(view, entity) || rankingShows(view, entity, name);
  });
}

/**
 * 計算が画面から辿れるか（§1）。種類ごとに、載る場所が決まっている：
 *   - 行ごとの計算 … 同じ entity の一覧（`show`・`show` の省略）・ボードの `highlight`・順位の部品
 *   - アプリ全体の計算 … ダッシュボードの数値の部品（`number`）
 *   - 見出しごとの集計 … ダッシュボードの棒・円の部品（`bar`・`pie`）
 *   - 精算 … 精算の表示（`type: settlement`）の一覧
 */
export function computedReachable(app: NormalizedAppSpec, computed: Computed): boolean {
  if (isComputedSettle(computed)) {
    return app.spec.views.some((view) => view.type === "settlement" && view.entity === computed.entity);
  }
  if (isGroupComputed(computed)) {
    return app.spec.views.some((view) =>
      (view.widgets ?? []).some(
        (part) => (part.type === "bar" || part.type === "pie") && part.value === computed.name,
      ),
    );
  }
  if (isAppComputed(computed)) {
    return app.spec.views.some((view) =>
      (view.widgets ?? []).some((part) => part.type === "number" && part.value === computed.name),
    );
  }
  if (!("entity" in computed)) return false;
  return rowComputedReachable(app, computed.entity, computed.name);
}

/**
 * 1 つの場所を確認する（§1）：
 *   - 名前が宣言に実在するか
 *   - 計算のときは、画面から辿れるか
 * 他の種類（entity・field・validation・action・view）は実在だけを確かめる——画面からの到達は
 * 評価器と対応表が別に受け持つ（この段の受入条件は「画面から辿れない**計算**」である）。
 */
export function checkLocation(app: NormalizedAppSpec, location: DeclarationLocation): LocationCheck {
  switch (location.kind) {
    case "entity":
      return findEntity(app, location.name) === undefined
        ? notFound(`宣言に entity ${location.name} が無い`)
        : { ok: true };
    case "field": {
      const entity = findEntity(app, location.entity);
      if (entity === undefined) return notFound(`宣言に entity ${location.entity ?? ""} が無い`);
      return Object.hasOwn(entity.fields, location.name)
        ? { ok: true }
        : notFound(`entity ${entity.name} に項目 ${location.name} が無い`);
    }
    case "validation": {
      const found = app.spec.validations.some(
        (validation) =>
          validation.name === location.name &&
          (location.entity === null || validation.entity === location.entity),
      );
      return found ? { ok: true } : notFound(`宣言に検査 ${location.name} が無い`);
    }
    case "computation": {
      const computed = findComputed(app, location);
      if (computed === undefined) return notFound(`宣言に計算 ${location.name} が無い`);
      return computedReachable(app, computed)
        ? { ok: true }
        : notFound(`計算 ${location.name} は画面から辿れない`);
    }
    case "action": {
      const found = app.spec.actions.some(
        (action) => action.name === location.name && (location.entity === null || action.entity === location.entity),
      );
      return found ? { ok: true } : notFound(`宣言に操作 ${location.name} が無い`);
    }
    case "view":
      return app.spec.views.some((view) => view.name === location.name)
        ? { ok: true }
        : notFound(`宣言に一覧 ${location.name} が無い`);
  }
}

/**
 * 対応表の落ちを、コードが確かめる（§1）。要件ごとに、対応が無いこと・挙げた場所が実在しないこと・
 * 計算が画面から辿れないことを集める。落ちの数は ⑦ の `correspondenceMisses` になる。
 */
export function checkCorrespondence(
  app: NormalizedAppSpec,
  list: RequirementList,
  entries: readonly CorrespondenceEntry[],
): readonly CorrespondenceMiss[] {
  const misses: CorrespondenceMiss[] = [];
  for (const requirement of list.requirements) {
    const entry = entries.find((candidate) => candidate.requirementId === requirement.id);
    if (entry === undefined) {
      misses.push({ requirementId: requirement.id, detail: `要件 ${requirement.id} の対応が無い` });
      continue;
    }
    for (const location of entry.locations) {
      const checked = checkLocation(app, location);
      if (!checked.ok) {
        misses.push({ requirementId: requirement.id, location, detail: checked.reason });
      }
    }
  }
  return misses;
}

/** ⑤a のデータ（原文・要件の一覧・宣言。§2.2 の「データとして囲んだ入力」にだけ置く） */
function buildData(input: CorrespondenceInput): readonly PromptData[] {
  return [
    { name: "原文", text: input.source },
    { name: "要件の一覧", text: serializeJson(input.list) },
    { name: "宣言", text: input.declaration.source },
  ];
}

/**
 * ⑤a を 1 回呼ぶ。形が合わない応答は 1 回だけやり直す（`callStructuredChecked`）。
 * 会話の答えは形だけを確かめ、**落ちはコードが確かめる**（`checkCorrespondence`）。
 */
export async function runCorrespondence(
  input: CorrespondenceInput,
): Promise<StageOutcome<CorrespondenceResult>> {
  const request = buildStructuredRequest({
    rules: CORRESPONDENCE_RULES,
    documents: input.documents,
    data: buildData(input),
    schemaName: CORRESPONDENCE_SCHEMA_NAME,
    schema: CORRESPONDENCE_SCHEMA,
    maxOutputTokens: input.gateway.maxOutputTokens("correspondence"),
  });
  const answer = await callStructuredChecked(input.gateway, { request, check: checkCorrespondenceOutput });
  if (!answer.ok) return answer;
  const misses = checkCorrespondence(input.app, input.list, answer.value.entries);
  return { ok: true, value: { entries: answer.value.entries, misses } };
}
