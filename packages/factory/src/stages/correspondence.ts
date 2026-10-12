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
  type ConfirmedPlan,
  type Entity,
  type NormalizedAppSpec,
  type View,
} from "@musunest/appspec-schema";
import type { CallGateway } from "../call.js";
import {
  DECLARATION_LOCATION_KINDS,
  LEGACY_DESIGN_CONTRACT,
  type CorrespondenceEntry,
  type CorrespondenceMiss,
  type CorrespondenceResult,
  type Declaration,
  type DeclarationLocation,
  type DeclarationLocationKind,
  type DesignContractVersion,
  type RequirementList,
  type RoleEntry,
  type RoleNameMapping,
  type RoleOwnership,
} from "../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  isRecord,
  ruleTexts,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RuleDefinition,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ⑤a の JSON Schema の名前 */
export const CORRESPONDENCE_SCHEMA_NAME = "requirement-correspondence";

/**
 * ⑤a の規則の定義（Issue #431）。**送る文は `text` から組む**——段は規則の文を手で持たない。
 * 7 文目（`R-corr-07`）を、所属と提出された対応を**申告**として独立に点検する旨へ直し、理由を述べる
 * 9 文目（`R-corr-09`）を足した。ID の重複・why・since の欠落は `ruleDefinitionDefects` で確かめる。
 */
export const CORRESPONDENCE_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-corr-01",
    text: "あなたは、作った宣言を、原文と要件の一覧に戻って点検する役である。",
    why: "⑤a の役割（宣言を正本へ戻って点検する）を明示する",
    since: "Issue #308",
  },
  {
    id: "R-corr-02",
    text: "要件ごとに、その要件を満たす宣言の中の場所（要素）を挙げる。",
    why: "要件と宣言の場所の対応を、要件ごとに作らせる",
    since: "Issue #308",
  },
  {
    id: "R-corr-03",
    text: "場所は種類（kind）・名前（name）・それを載せている entity の名前（entity）で指す。",
    why: "場所の指し方を、コードが確かめられる形に固定する",
    since: "Issue #308",
  },
  {
    id: "R-corr-04",
    text: "kind は entity・field・validation・computation・action・view のいずれかである。entity 自身のとき、entity は null にする。",
    why: "場所の種類の語彙を閉じ、entity 自身の扱いを決める",
    since: "Issue #308",
  },
  {
    id: "R-corr-05",
    text: "宣言に実在する名前だけを挙げる。画面から辿れない計算は挙げない。",
    why: "実在しない名前と、画面から辿れない計算を挙げさせない",
    since: "Issue #308",
  },
  {
    id: "R-corr-06",
    text: "要件ごとに 1 つの項目を返す。要件 ID は一覧のまま写す。",
    why: "要件ごとに 1 項目を返させ、ID を写させる",
    since: "Issue #308",
  },
  {
    id: "R-corr-07",
    text: "「提出された対応」と「要件ごとの所属」は、点検すべき対応の申告である。確定した仕様（無ければ原文）・要件の一覧・宣言の構造に照らして、その場所がその要件を満たすかを独立に点検する。期待の値と試験の合否は与えられない——それらに寄せずに点検する。実在するという理由だけで場所を挙げない。",
    why: "所属と提出された対応は申告であり、写すと誤った所属を追認するため、正本へ戻って独立に点検する",
    since: "Issue #308",
    modes: ["M-01"],
  },
  {
    id: "R-corr-08",
    text: "対応の名前が宣言に実在しない・対象の種類が合わない・その要件について対応表が挙げた場所の外にある・共有や別名を明示せずに同じ場所へ二重に対応している場合は、その旨を点検の結果として扱う。",
    why: "点検で見つけた落ちの分類を決める",
    since: "Issue #308",
  },
  {
    id: "R-corr-09",
    text: "申告をそのまま写すと誤った所属を追認するため、正本へ戻って独立に点検する。意味が合わなければその場所を挙げず、合わない旨を結果にする。",
    why: "独立の点検が要る理由（追認を避ける）を規則そのものに残す",
    since: "Issue #431",
    modes: ["M-01", "M-02"],
  },
];

/** ⑤a に足す規則（共通の規則は buildStructuredRequest が先頭に付ける。定義の `text` から組む） */
export const CORRESPONDENCE_RULES: readonly string[] = ruleTexts(CORRESPONDENCE_RULE_DEFINITIONS);

/**
 * ⑤a のやり直しにだけ足す規則の定義（配列の外。Issue #322・#431）。「落ちた場所は宣言に実在するので、
 * その要件を満たす場所として挙げる」は**消した**——落ちはデータとして渡し、挙げるかどうかは独立の点検に
 * 任せる（実在だけで場所を足させない）。
 */
export const CORRESPONDENCE_REDO_DEFINITION: RuleDefinition = {
  id: "R-corr-redo",
  text: "「前回の対応表の落ち」が与えられたときは、要件ごとに点検し直して対応表を出し直す。落ちは「要件 R に、所属の申告どおりの場所 L が無い」というデータであり、挙げるかどうかは独立の点検に任せる。",
  why: "落ちた場所を実在だけで足させず、要件ごとの独立の点検に任せるため",
  since: "Issue #322",
  modes: ["M-01"],
};

/** ⑤a のやり直しにだけ足す規則（定義の `text`） */
export const CORRESPONDENCE_REDO_RULE: string = CORRESPONDENCE_REDO_DEFINITION.text;

/** 確定した仕様を渡したときだけ足す規則の定義（§5・Issue #334・#391）。**正本は確定した仕様**である */
export const CORRESPONDENCE_SETTLED_DEFINITION: RuleDefinition = {
  id: "R-corr-settled",
  text: "「確定した仕様」が与えられたときは、それが**正本**である（要件の一覧の文、とくに「参考の文脈」は補足である）。原文ではなく**確定した仕様の要件と出どころ**を根拠にする。確定した仕様の要件が満たすべきものを、宣言の中で点検する（原文を優先して、利用者が確定した変更を戻さない）。",
  why: "確定した仕様を正本にし、利用者が確定した変更を戻さないため",
  since: "Issue #334",
};

/** 確定した仕様を渡したときだけ足す規則（定義の `text`） */
export const CORRESPONDENCE_SETTLED_RULE: string = CORRESPONDENCE_SETTLED_DEFINITION.text;

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
  /**
   * 前の ⑤a の対応表の落ち（⑤a のやり直しのときだけ渡す。Issue #322）。
   * 「対応の名前が対応表の外にある」落ちをここに渡し、**落ちた場所を伝えて**対応表を作り直させる。
   */
  readonly previousMisses?: readonly CorrespondenceMiss[];
  /**
   * 確定した仕様（`plan.json`。§5・Issue #334）。渡されたときは、**原文の代わりに確定した仕様の要件と
   * 出どころを根拠**にして点検させる（原文を優先すると、利用者が確定した変更を戻してしまう）。
   */
  readonly plan?: ConfirmedPlan;
  /**
   * 要件ごとの所属（② の設計から写す。Issue #431）。**提出された対応とは別の `<data name=`** で渡す。
   * 新契約では必須。渡されたときだけ、⑤a のコードの点検を**要件ごと**に行う。
   */
  readonly ownership?: readonly RequirementRoleOwnership[];
  /**
   * 設計の契約の版（決定 ⑨・Issue #418・#431）。**呼ぶ側が明示する**——`legacy` を明示したときだけ、
   * 従来の**表全体**の点検を保つ。省けば新契約（要件ごとの点検）。所属の欄の有無から版を推定しない。
   */
  readonly version?: DesignContractVersion;
}

/** 要件ごとの所属（要件 ID → 役割 ID と根拠の並び。② の設計から写す。Issue #431） */
export interface RequirementRoleOwnership {
  readonly requirementId: string;
  readonly ownership: readonly RoleOwnership[];
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
 * 名前が、宣言にその種類の場所として実在するか（所属の entity は問わない）。
 *
 * 「対応の名前が ⑤a の対応表の外にある」（名前は実在するが、その要件の対応表が挙げていない）と、
 * 「実在しない名前・種類違い」（③ の対応そのものが誤り）を**分ける**のに使う（Issue #322）。
 * entity を問わないので、行ごとの計算のように所属が決まる場所も「実在する」と見なせる。
 */
export function declarationHasNamedLocation(
  app: NormalizedAppSpec,
  kind: DeclarationLocationKind,
  name: string,
): boolean {
  switch (kind) {
    case "entity":
      return app.spec.entities.some((entity) => entity.name === name);
    case "field":
      return app.spec.entities.some((entity) => Object.hasOwn(entity.fields, name));
    case "validation":
      return app.spec.validations.some((validation) => validation.name === name);
    case "computation":
      return app.spec.computed.some((computed) => computed.name === name);
    case "action":
      return app.spec.actions.some((action) => action.name === name);
    case "view":
      return app.spec.views.some((view) => view.name === name);
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
  options: RoleMappingCheckOptions & {
    readonly roles?: readonly RoleEntry[];
    readonly mappings?: readonly RoleNameMapping[];
  } = {},
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
    misses.push(...checkRoleMappings(app, options.roles, entries, options.mappings, options));
  }
  return misses;
}

/**
 * `checkRoleMappings` に渡す、版と要件ごとの所属（Issue #431）。**版は呼ぶ側が明示する**——
 * `version` が `legacy` のときだけ従来の**表全体**の点検を保つ。省けば新契約（要件ごとの点検）。
 */
export interface RoleMappingCheckOptions {
  readonly ownership?: readonly RequirementRoleOwnership[];
  readonly version?: DesignContractVersion;
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

/**
 * 宣言に、その**種類・所属・名前**の場所が実在するか（画面からの到達は別に見る。Issue #431）。
 * 名前だけの `declarationHasNamedLocation` と違い、**別の entity の同名を実在と見なさない**——⑤b の
 * 構造の検査の行き先（`correspondence-redo` か `correspondence-defect` か）を分けるのに使う。
 */
export function declarationHasLocation(app: NormalizedAppSpec, location: DeclarationLocation): boolean {
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
 * 項目が、その entity の一覧か表から辿れるか（§1・§1.3・Issue #324）。`show` に入っているか、`show` を
 * 省略して全部を出す一覧（種類なし・`table`・`list`）に載っていれば辿れる。⑤a の点検（`screenReachable`）と
 * ⑤b の「項目 × 画面」の判定（`judgeFieldScreen`）が、**同じ規則**を使う。
 */
export function fieldReachableFromScreen(app: NormalizedAppSpec, location: DeclarationLocation): boolean {
  if (location.kind !== "field") return false;
  return app.spec.views.some((view) => {
    if (view.entity !== location.entity) return false;
    if (view.show !== undefined) return view.show.includes(location.name);
    return view.type === undefined || view.type === "table" || view.type === "list";
  });
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
  if (location.kind === "field") return fieldReachableFromScreen(app, location);
  return true;
}

/**
 * 提出された対応の点検の落ち（Issue #324）。`CorrespondenceMiss` に、行き先（`route`）を足したものである。
 *
 *   - `correspondence-defect` … **③ のやり直し**へ回す「対応の表の不備」（実在しない名前・種類違い・
 *     対応表の外・共有の不備）。対応の表そのものが誤っているので、③ に出し直させる（§1.3.1）
 *   - `correspondence-redo` … **⑤a のやり直し**へ回す「要件の対応表の外」（場所は宣言に実在するが、
 *     その要件の対応表が挙げていない）。③ の対応は正しいので ③ をやり直しても直らない（Issue #431）
 *   - `missing-element` … **⑥ 直す**へ回す「要件に要る宣言の要素の欠落」（画面から辿れない場所）。
 *     名前は実在するので、③ をやり直しても直らない。宣言の要素（項目・`show`）を足す ⑥ へ回す
 *
 * 名前は `RoutedFailure` の行き先とそろえてある。落ちには、**もとの要件 ID** を入れる（空にしない）。
 */
export interface RoleMappingMiss extends CorrespondenceMiss {
  readonly route: "correspondence-defect" | "correspondence-redo" | "missing-element";
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
 * ただし、その落ちの行き先は **⑥ 直す**である（名前が実在するので ③ のやり直しでは直らない。Issue #324）。
 * 落ちには、その場所を挙げている要件の ID を入れる（空にしない）。
 */
export function checkRoleMappings(
  app: NormalizedAppSpec,
  roles: readonly RoleEntry[],
  entries: readonly CorrespondenceEntry[],
  mappings: readonly RoleNameMapping[],
  options: RoleMappingCheckOptions = {},
): readonly RoleMappingMiss[] {
  if (options.version !== LEGACY_DESIGN_CONTRACT) {
    return checkRoleMappingsPerRequirement(app, roles, entries, mappings, options.ownership ?? []);
  }
  return checkRoleMappingsTableWide(app, roles, entries, mappings);
}

/**
 * 従来の**表全体**の点検（`legacy` を明示したときだけ。Issue #308）。役割 ID → 宣言の名前の対応を、
 * 表の全部の場所（`tableLocations`）に照らす。新契約では `checkRoleMappingsPerRequirement` が要件ごとに見る。
 */
function checkRoleMappingsTableWide(
  app: NormalizedAppSpec,
  roles: readonly RoleEntry[],
  entries: readonly CorrespondenceEntry[],
  mappings: readonly RoleNameMapping[],
): readonly RoleMappingMiss[] {
  const misses: RoleMappingMiss[] = [];
  const roleById = new Map(roles.map((role) => [role.roleId, role]));
  const nameByRoleId = new Map(mappings.map((mapping) => [mapping.roleId, mapping.name]));
  const tableLocations = entries.flatMap((entry) => entry.locations);
  const resolved: { readonly role: RoleEntry; readonly location: DeclarationLocation }[] = [];
  /** その場所を挙げている要件の ID（落ちに、もとの要件 ID を入れる。Issue #324） */
  const requirementIdOf = (location: DeclarationLocation): string =>
    entries.find((entry) => entry.locations.some((candidate) => sameLocation(candidate, location)))
      ?.requirementId ?? "";

  for (const mapping of mappings) {
    const role = roleById.get(mapping.roleId);
    if (role === undefined) {
      misses.push({
        requirementId: "",
        route: "correspondence-defect",
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
          route: "correspondence-defect",
          detail: `役割 ${role.roleId} の所属の entity（役割 ID ${role.entity}）の対応が無い`,
        });
        continue;
      }
      entityName = mapped;
    }
    const location: DeclarationLocation = { kind, entity: entityName, name: mapping.name };
    if (!declarationHasLocation(app, location)) {
      const kinds = declarationKindsOfName(app, mapping.name, entityName);
      misses.push({
        requirementId: "",
        route: "correspondence-defect",
        location,
        detail:
          kinds.length > 0
            ? `役割 ${role.roleId} の名前 ${mapping.name} は宣言に ${kinds.join("・")} としてある（対象の種類 ${kind} と合わない）`
            : `宣言に ${kind} ${mapping.name} が無い（役割 ${role.roleId} の実在しない名前）`,
      });
      continue;
    }
    if (!tableLocations.some((candidate) => sameLocation(candidate, location))) {
      misses.push({
        requirementId: "",
        route: "correspondence-defect",
        location,
        detail: `役割 ${role.roleId} の場所（${kind} ${mapping.name}）が対応表の外にある`,
      });
      continue;
    }
    if (!screenReachable(app, location)) {
      misses.push({
        requirementId: requirementIdOf(location),
        route: "missing-element",
        location,
        detail: `役割 ${role.roleId} の場所（${kind} ${mapping.name}）は画面から辿れない`,
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
        route: "correspondence-defect",
        location,
        detail: `同じ場所（${location.kind} ${location.name}）に複数の役割 ID が対応しているが、役割 ${role.roleId} は共有（shared）も別名（aliasOf）も明示していない`,
      });
    }
  }
  return misses;
}

/**
 * 要件ごとの所属を点検する（新契約。Issue #431）。③ が提出した対応を**表全体**ではなく、**要件ごと**に、
 * その要件が所属させた役割の場所がその要件の対応表の内側にあるかで見る（門は緩めない）。落ちの分類：
 *
 *   - 表の役割の対応の提出漏れ・重複 … 対応の表そのものの不備なので ③ のやり直し（`correspondence-defect`）
 *   - 所属の場所が**その要件の対応表の外**で、宣言にその種類・所属・名前で実在する … ⑤a のやり直し
 *     （`correspondence-redo`。要件 ID と場所つき）
 *   - 所属の場所が実在しない・種類違い … ③ の対応そのものが誤り（`correspondence-defect`）
 *
 * 既存の点検（表に無い役割 ID・所属 entity の対応が無い・実在しない名前・種類違い・画面から辿れない＝
 * `missing-element`・共有や別名の明示）も残す。落ちの要件 ID は、所属から引いて**空にしない**。
 */
function checkRoleMappingsPerRequirement(
  app: NormalizedAppSpec,
  roles: readonly RoleEntry[],
  entries: readonly CorrespondenceEntry[],
  mappings: readonly RoleNameMapping[],
  ownership: readonly RequirementRoleOwnership[],
): readonly RoleMappingMiss[] {
  const misses: RoleMappingMiss[] = [];
  const roleById = new Map(roles.map((role) => [role.roleId, role]));
  const nameByRoleId = new Map<string, string>();
  const countByRoleId = new Map<string, number>();
  for (const mapping of mappings) {
    countByRoleId.set(mapping.roleId, (countByRoleId.get(mapping.roleId) ?? 0) + 1);
    if (!nameByRoleId.has(mapping.roleId)) nameByRoleId.set(mapping.roleId, mapping.name);
  }
  /** その役割を所属させた要件 ID の並び（表の順。重複は 1 つに数える） */
  const ownerIdsOf = (roleId: string): readonly string[] => {
    const ids: string[] = [];
    for (const entry of ownership) {
      if (entry.ownership.some((own) => own.roleId === roleId) && !ids.includes(entry.requirementId)) {
        ids.push(entry.requirementId);
      }
    }
    return ids;
  };
  /** 落ちの要件 ID（所属の先頭。所属が無ければ空。Issue #431） */
  const firstOwner = (roleId: string): string => ownerIdsOf(roleId)[0] ?? "";

  // 1. 表の**全部の役割**の対応が、ちょうど 1 つあること（提出漏れ・重複は対応の表の不備＝③ のやり直し）
  for (const role of roles) {
    const count = countByRoleId.get(role.roleId) ?? 0;
    if (count === 0) {
      misses.push({
        requirementId: firstOwner(role.roleId),
        route: "correspondence-defect",
        detail: `役割 ${role.roleId} の対応が提出されていない（対応の表の不備）`,
      });
    } else if (count > 1) {
      misses.push({
        requirementId: firstOwner(role.roleId),
        route: "correspondence-defect",
        detail: `役割 ${role.roleId} の対応が重複している（対応の表の不備）`,
      });
    }
  }

  // 2. 提出された対応の、名前・種類・所属 entity の実在と、画面からの到達（既存の点検。対応表の外は 3.）
  const resolved: { readonly role: RoleEntry; readonly location: DeclarationLocation }[] = [];
  for (const mapping of mappings) {
    const role = roleById.get(mapping.roleId);
    if (role === undefined) {
      misses.push({
        requirementId: "",
        route: "correspondence-defect",
        detail: `役割 ID ${mapping.roleId} は設計の役割 ID の表に無い（対応表の外）`,
      });
      continue;
    }
    const kind = declarationKindOfRole(role.kind);
    const owner = firstOwner(role.roleId);
    let entityName: string | null = null;
    if (role.entity !== null) {
      const mapped = nameByRoleId.get(role.entity);
      if (mapped === undefined) {
        misses.push({
          requirementId: owner,
          route: "correspondence-defect",
          detail: `役割 ${role.roleId} の所属の entity（役割 ID ${role.entity}）の対応が無い`,
        });
        continue;
      }
      entityName = mapped;
    }
    const location: DeclarationLocation = { kind, entity: entityName, name: mapping.name };
    if (!declarationHasLocation(app, location)) {
      const kinds = declarationKindsOfName(app, mapping.name, entityName);
      misses.push({
        requirementId: owner,
        route: "correspondence-defect",
        location,
        detail:
          kinds.length > 0
            ? `役割 ${role.roleId} の名前 ${mapping.name} は宣言に ${kinds.join("・")} としてある（対象の種類 ${kind} と合わない）`
            : `宣言に ${kind} ${mapping.name} が無い（役割 ${role.roleId} の実在しない名前）`,
      });
      continue;
    }
    if (!screenReachable(app, location)) {
      misses.push({
        requirementId: owner,
        route: "missing-element",
        location,
        detail: `役割 ${role.roleId} の場所（${kind} ${mapping.name}）は画面から辿れない`,
      });
      continue;
    }
    resolved.push({ role, location });
  }

  // 3. 要件 R が所属させた役割 X の場所 L が、**R の対応表の項目の中**にあること（新契約。Issue #431）
  for (const entry of ownership) {
    const table = entries.find((candidate) => candidate.requirementId === entry.requirementId);
    for (const own of entry.ownership) {
      const role = roleById.get(own.roleId);
      if (role === undefined) continue;
      const mapping = mappings.find((candidate) => candidate.roleId === own.roleId);
      if (mapping === undefined) continue; // 1. で、提出されていない落ちにした
      const kind = declarationKindOfRole(role.kind);
      const entityName = role.entity === null ? null : nameByRoleId.get(role.entity) ?? null;
      const location: DeclarationLocation = { kind, entity: entityName, name: mapping.name };
      const inTable = table !== undefined && table.locations.some((candidate) => sameLocation(candidate, location));
      if (inTable) continue;
      if (declarationHasLocation(app, location)) {
        misses.push({
          requirementId: entry.requirementId,
          route: "correspondence-redo",
          location,
          detail: `要件 ${entry.requirementId} の対応表に ${kind} ${mapping.name} が無い（所属の申告どおりの場所は宣言に実在する）`,
        });
      } else {
        misses.push({
          requirementId: entry.requirementId,
          route: "correspondence-defect",
          location,
          detail: `要件 ${entry.requirementId} の対応表に ${kind} ${mapping.name} が無く、宣言にも実在しない`,
        });
      }
    }
  }

  // 4. 共有・別名の明示（既存の点検。resolved から）
  const groups = new Map<string, { readonly role: RoleEntry; readonly location: DeclarationLocation }[]>();
  for (const item of resolved) {
    const key = locationKey(item.location);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const declared = list.some(({ role }) => role.shared || role.aliasOf !== null);
    if (declared) continue;
    for (const { role, location } of list) {
      misses.push({
        requirementId: firstOwner(role.roleId),
        route: "correspondence-defect",
        location,
        detail: `同じ場所（${location.kind} ${location.name}）に複数の役割 ID が対応しているが、役割 ${role.roleId} は共有（shared）も別名（aliasOf）も明示していない`,
      });
    }
  }
  return misses;
}

/** ⑤a のデータ（原文・要件の一覧・宣言。§2.2 の「データとして囲んだ入力」にだけ置く） */
function buildData(input: CorrespondenceInput): readonly PromptData[] {
  // 確定した仕様があるときは、原文ではなくその要件と出どころを根拠にする（§5・Issue #334）
  const basis: PromptData =
    input.plan === undefined
      ? { name: "原文", text: input.source }
      : { name: "確定した仕様", text: serializeJson(input.plan) };
  const data: PromptData[] = [
    basis,
    { name: "要件の一覧", text: serializeJson(input.list) },
    { name: "宣言", text: input.declaration.source },
  ];
  // ③ の提出した対応は、独立に点検させるためにデータとしてだけ渡す（期待の値と試験の合否は渡さない）
  if (input.mappings !== undefined) {
    data.push({ name: "提出された対応", text: serializeJson(input.mappings) });
  }
  // 要件ごとの所属は、**提出された対応とは別のデータ**として渡す（申告として独立に点検させる。Issue #431）。
  if (input.ownership !== undefined) {
    data.push({ name: "要件ごとの所属", text: serializeJson(input.ownership) });
  }
  // ⑤a のやり直しでは、落ちた場所を伝えて対応表を作り直させる（Issue #322）
  if (input.previousMisses !== undefined && input.previousMisses.length > 0) {
    data.push({ name: "前回の対応表の落ち", text: serializeJson(input.previousMisses) });
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
  const rules: string[] = [...CORRESPONDENCE_RULES];
  if (input.plan !== undefined) rules.push(CORRESPONDENCE_SETTLED_RULE);
  if (input.previousMisses !== undefined && input.previousMisses.length > 0) {
    rules.push(CORRESPONDENCE_REDO_RULE);
  }
  const request = buildStructuredRequest({
    rules,
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
    ...(input.ownership === undefined ? {} : { ownership: input.ownership }),
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  return { ok: true, value: { entries: answer.value.entries, misses } };
}
