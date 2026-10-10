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
//
// Issue #308 で、⑤a は **③ が提出した「役割 ID → 宣言の名前」の対応（mappings）を独立に点検する**（§1.2）。
// 点検するのはコードであり、**期待の値と試験の合否は見ない**（見せると、同じ要件の中の同じ型の別の要素へ
// 結び付けても通る R2-1 の誤りを落とせない）。落ちの分類は「実在しない名前・種類違い・対応表の外・
// 明示しない共有・空の対応の場所」である。空の対応の場所は、旧来の対応表の点検でも落ちにする（R2-2）。
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
  type DeclarationLocationKind,
  type RequirementList,
  type RoleEntry,
  type RoleNameMapping,
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
  "「提出された対応」（③ が提出した役割 ID → 宣言の名前の対応）が与えられたら、原文・要件の一覧・宣言の構造に照らして、その対応を独立に点検する。期待の値と試験の合否は与えられない——それらに寄せずに点検する。",
  "対応の名前が宣言に実在しない・対象の種類が合わない・その要件について対応表が挙げた場所の外にある・共有や別名を明示せずに同じ場所へ二重に対応している場合は、その旨を点検の結果として扱う。",
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
  /**
   * ② の役割 ID の表（③ の提出した対応を点検するのに使う。§1.2・Issue #308）。
   * 渡されなければ、提出された対応の点検は行わない（旧形式の経路）。
   */
  readonly roles?: readonly RoleEntry[];
  /**
   * ③ が提出した「役割 ID → 宣言の名前」の対応（§1・Issue #308）。渡されたときだけ独立に点検する。
   * **期待の値と試験の合否はここへ入れない。**
   */
  readonly mappings?: readonly RoleNameMapping[];
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
 * 対応表の落ちを、コードが確かめる（§1）。要件ごとに、対応が無いこと・対応の場所が空であること・
 * 挙げた場所が実在しないこと・計算が画面から辿れないことを集める。落ちの数は ⑦ の
 * `correspondenceMisses` になる。
 *
 * `options` に ② の役割 ID の表と ③ の提出した対応を渡すと、**その対応も独立に点検する**（Issue #308。
 * `checkRoleMappings`）。渡さなければ旧来の点検だけを行う（後方互換）。
 */
export function checkCorrespondence(
  app: NormalizedAppSpec,
  list: RequirementList,
  entries: readonly CorrespondenceEntry[],
  options: { readonly roles?: readonly RoleEntry[]; readonly mappings?: readonly RoleNameMapping[] } = {},
): readonly CorrespondenceMiss[] {
  const misses: CorrespondenceMiss[] = [];
  for (const requirement of list.requirements) {
    const entry = entries.find((candidate) => candidate.requirementId === requirement.id);
    if (entry === undefined) {
      misses.push({ requirementId: requirement.id, detail: `要件 ${requirement.id} の対応が無い` });
      continue;
    }
    if (entry.locations.length === 0) {
      misses.push({ requirementId: requirement.id, detail: `要件 ${requirement.id} の対応の場所が空である` });
      continue;
    }
    for (const location of entry.locations) {
      const checked = checkLocation(app, location);
      if (!checked.ok) {
        misses.push({ requirementId: requirement.id, location, detail: checked.reason });
      }
    }
  }
  if (options.roles !== undefined && options.mappings !== undefined) {
    misses.push(...checkRoleMappings(app, options.roles, entries, options.mappings));
  }
  return misses;
}

/** 役割 ID の対象の種類が、宣言の場所の種類に対応する（§1.2・Issue #308） */
export function declarationKindOfRole(kind: RoleEntry["kind"]): DeclarationLocationKind {
  switch (kind) {
    case "entity":
      return "entity";
    case "field":
      return "field";
    case "computation":
      return "computation";
    case "operation":
      return "action";
    case "screen":
      return "view";
  }
}

const locationKey = (location: DeclarationLocation): string =>
  `${location.kind}\u0000${location.entity ?? ""}\u0000${location.name}`;

const sameLocation = (a: DeclarationLocation, b: DeclarationLocation): boolean =>
  a.kind === b.kind && (a.entity ?? null) === (b.entity ?? null) && a.name === b.name;

/** 宣言に、その種類・所属・名前の場所が実在するか（画面からの到達は別に見る） */
function declarationHasLocation(app: NormalizedAppSpec, location: DeclarationLocation): boolean {
  switch (location.kind) {
    case "entity":
      return app.spec.entities.some((entity) => entity.name === location.name);
    case "field": {
      const entity = findEntity(app, location.entity);
      return entity !== undefined && Object.hasOwn(entity.fields, location.name);
    }
    case "validation":
      return app.spec.validations.some(
        (validation) =>
          validation.name === location.name &&
          (location.entity === null || validation.entity === location.entity),
      );
    case "computation":
      return findComputed(app, location) !== undefined;
    case "action":
      return app.spec.actions.some(
        (action) => action.name === location.name && (location.entity === null || action.entity === location.entity),
      );
    case "view":
      return app.spec.views.some((view) => view.name === location.name);
  }
}

/** 同じ名前が、宣言でどの種類として実在するか（種類違いの判別に使う。§1.2・Issue #308） */
function declarationKindsOfName(
  app: NormalizedAppSpec,
  name: string,
  entity: string | null,
): readonly DeclarationLocationKind[] {
  const kinds: DeclarationLocationKind[] = [];
  const host = findEntity(app, entity);
  if (app.spec.entities.some((candidate) => candidate.name === name)) kinds.push("entity");
  if (host !== undefined && Object.hasOwn(host.fields, name)) kinds.push("field");
  if (app.spec.validations.some((v) => v.name === name && (entity === null || v.entity === entity))) {
    kinds.push("validation");
  }
  if (app.spec.computed.some((c) => c.name === name && (entity === null || ("entity" in c && c.entity === entity)))) {
    kinds.push("computation");
  }
  if (app.spec.actions.some((a) => a.name === name && (entity === null || a.entity === entity))) kinds.push("action");
  if (app.spec.views.some((v) => v.name === name)) kinds.push("view");
  return kinds;
}

/**
 * 計算でない場所も、画面から辿れるか（create の操作・一覧か表の `show`。§1・Issue #308）。
 * 計算は `checkLocation` が到達を見るので、ここでは entity・項目を確かめる。他の種類は実在で足りる。
 */
function screenReachable(app: NormalizedAppSpec, location: DeclarationLocation): boolean {
  if (location.kind === "entity") {
    const hasCreate = app.spec.actions.some(
      (action) => (action.kind ?? "create") === "create" && action.entity === location.name,
    );
    const shown = app.spec.views.some(
      (view) =>
        view.entity === location.name &&
        (view.type === undefined || view.type === "table" || view.type === "list"),
    );
    return hasCreate || shown;
  }
  if (location.kind === "field") {
    return app.spec.views.some((view) => {
      if (view.entity !== location.entity) return false;
      if (view.show !== undefined) return view.show.includes(location.name);
      return view.type === undefined || view.type === "table" || view.type === "list";
    });
  }
  return true;
}

/**
 * ③ が提出した「役割 ID → 宣言の名前」の対応を、コードが**独立に点検する**（§1.2・Issue #308）。
 * **期待の値と試験の合否は見ない。** 落ちの分類は次のとおり：
 *
 *   - 実在しない名前 … 対応の名前が宣言に無い
 *   - 種類違い … 名前はあるが、役割の対象の種類と合わない
 *   - 対応表の外 … 役割 ID が役割 ID の表に無い／場所が対応表の外にある
 *   - 明示しない共有 … 同じ場所に複数の役割 ID が対応するのに、共有も別名も明示していない
 *
 * 画面から辿れない場所も落ちにする（計算は `checkLocation`、entity・項目は `screenReachable`）。
 */
export function checkRoleMappings(
  app: NormalizedAppSpec,
  roles: readonly RoleEntry[],
  entries: readonly CorrespondenceEntry[],
  mappings: readonly RoleNameMapping[],
): readonly CorrespondenceMiss[] {
  const misses: CorrespondenceMiss[] = [];
  const roleById = new Map(roles.map((role) => [role.roleId, role]));
  const nameByRoleId = new Map(mappings.map((mapping) => [mapping.roleId, mapping.name]));
  const tableLocations = entries.flatMap((entry) => entry.locations);
  const resolved: { readonly role: RoleEntry; readonly location: DeclarationLocation }[] = [];

  for (const mapping of mappings) {
    const role = roleById.get(mapping.roleId);
    if (role === undefined) {
      misses.push({
        requirementId: "",
        detail: `役割 ID ${mapping.roleId} は設計の役割 ID の表に無い（対応表の外）`,
      });
      continue;
    }
    const kind = declarationKindOfRole(role.kind);
    let entityName: string | null = null;
    if (role.entity !== null) {
      const mapped = nameByRoleId.get(role.entity);
      if (mapped === undefined) {
        misses.push({
          requirementId: "",
          detail: `役割 ${role.roleId} の所属の entity（役割 ID ${role.entity}）の対応が無い`,
        });
        continue;
      }
      entityName = mapped;
    }
    const location: DeclarationLocation = { kind, entity: entityName, name: mapping.name };
    if (!declarationHasLocation(app, location)) {
      const kinds = declarationKindsOfName(app, mapping.name, entityName);
      if (kinds.length > 0) {
        misses.push({
          requirementId: "",
          location,
          detail: `役割 ${role.roleId} の名前 ${mapping.name} は宣言に ${kinds.join("・")} としてある（対象の種類 ${kind} と合わない）`,
        });
      } else {
        misses.push({
          requirementId: "",
          location,
          detail: `宣言に ${kind} ${mapping.name} が無い（役割 ${role.roleId} の実在しない名前）`,
        });
      }
      continue;
    }
    if (!screenReachable(app, location)) {
      misses.push({
        requirementId: "",
        location,
        detail: `役割 ${role.roleId} の場所（${kind} ${mapping.name}）は画面から辿れない`,
      });
      continue;
    }
    if (!tableLocations.some((candidate) => sameLocation(candidate, location))) {
      misses.push({
        requirementId: "",
        location,
        detail: `役割 ${role.roleId} の場所（${kind} ${mapping.name}）が対応表の外にある`,
      });
      continue;
    }
    resolved.push({ role, location });
  }

  const groups = new Map<string, { readonly role: RoleEntry; readonly location: DeclarationLocation }[]>();
  for (const item of resolved) {
    const key = locationKey(item.location);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // 共有（shared）か別名（aliasOf）を**誰か 1 人が明示している**ときだけ許す（§1・②・R2-8）
    const declared = list.some(({ role }) => role.shared || role.aliasOf !== null);
    if (declared) continue;
    for (const { role, location } of list) {
      misses.push({
        requirementId: "",
        location,
        detail: `同じ場所（${location.kind} ${location.name}）に複数の役割 ID が対応しているが、役割 ${role.roleId} は共有（shared）も別名（aliasOf）も明示していない`,
      });
    }
  }
  return misses;
}

/** ⑤a のデータ（原文・要件の一覧・宣言。§2.2 の「データとして囲んだ入力」にだけ置く） */
function buildData(input: CorrespondenceInput): readonly PromptData[] {
  const data: PromptData[] = [
    { name: "原文", text: input.source },
    { name: "要件の一覧", text: serializeJson(input.list) },
    { name: "宣言", text: input.declaration.source },
  ];
  // ③ の提出した対応は、独立に点検させるためにデータとしてだけ渡す（期待の値と試験の合否は渡さない）
  if (input.mappings !== undefined) {
    data.push({ name: "提出された対応", text: serializeJson(input.mappings) });
  }
  return data;
}

/**
 * ⑤a を 1 回呼ぶ。形が合わない応答は 1 回だけやり直す（`callStructuredChecked`）。
 * 会話の答えは形だけを確かめ、**落ちはコードが確かめる**（`checkCorrespondence`）。
 * ③ の提出した対応（`mappings`）と ② の役割 ID の表（`roles`）が渡されたときは、その点検もコードが行う。
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
  const misses = checkCorrespondence(input.app, input.list, answer.value.entries, {
    ...(input.roles === undefined ? {} : { roles: input.roles }),
    ...(input.mappings === undefined ? {} : { mappings: input.mappings }),
  });
  return { ok: true, value: { entries: answer.value.entries, misses } };
}
