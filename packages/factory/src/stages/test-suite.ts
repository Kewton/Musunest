// ②' 試験を作って固定する（02-architecture.md §1・§1.3・F-9・Issue #307）。
//
// **宣言を見せない**別の会話で、要件から期待を作らせる（宣言に合わせた期待を作らせない。§1.3）。
// だからこの段には要件の一覧だけを渡し、宣言は渡さない。
//
// Issue #307 で、②' の入力の契約と、固定する前のコードの検査を直した（疎通の確認で、固定した試験が
// 宣言の要素に結び付かず、直す段が締切まで回り続けた）：
//   - 要件ごとの**種類**を、②' が原文と要件の一覧から**独立に**分類し直す（設計の出力は見せない）。
//     設計の種類と食い違う要件は**決まりを含むほうへ倒し**、食い違いを結果に残す（`reconcileNatures`）
//   - **在ることだけ**の要件には、異常・境界の試験や検査（validate）の試験を作らない
//   - 試験の対象と参照の行を、**自由な文ではなく役割 ID** で指す。入力の契約（固定の行 ID・評価の対象の
//     行 ID・空の entity の集合）を足す
//   - 異常の期待を**操作ごとの型**にする（検査は誤りコード、計算・集計は値も許す）
//
// Issue #316 で、**走らせる部分（run.ts）が ②' に ② の設計を渡す**ようにした。渡さないと ②' は
// 「設計が無いときの古い経路」に入り、上の突き合わせと役割 ID の検査が実際のパイプラインでは一度も
// 効かなかった（疎通の確認では、在ることだけの要件に異常・境界の試験を求めて未達で終わった）。設計が
// 渡されたときは、プロンプトのデータに**役割 ID の表と要件ごとの種類**を載せる（試験の対象は、その表の
// 役割 ID で指させる）。旧形式の記録（設計の新しい欄が無い）は、旧来の検査だけを行う（後方互換）。
//
// コードが次を確かめてから**固定する**。満たさなければ 1 回だけ作り直させ、それでも欠ける要件は
// 未達として持つ（合否はここでは決めない）：
//
//   - 試験の集合が空でない
//   - 要件 ID が ① の一覧に実在する
//   - 要件ごとの種類に応じて、正常・異常・境界（決まりを含む）か、正常だけ（在ることだけ）がそろう
//   - selector（要件 ID と役割 ID）が 1 つの要件と役割に一意に決まる
//   - 上限（要件ごとの試験の数・参照データの行数。§1.5）
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import {
  REQUIREMENT_NATURES,
  STRUCTURAL_ASSERTIONS,
  TEST_KINDS,
  TEST_OPERATIONS,
  TEST_TARGET_KINDS,
  checkTestSuite,
  isRequirementNature,
  type FixedTest,
  type RequirementClassification,
  type RequirementNature,
  type TestOperation,
  type TestSuite,
  type TestTarget,
  type TestTargetKind,
} from "../fixed-test.js";
import { checkLimit } from "../limits.js";
import type { DesignContractVersion, DesignResult, NatureDiscrepancy, RequirementList, RoleEntry } from "../pipeline.js";
import { LEGACY_DESIGN_CONTRACT } from "../pipeline.js";
import type { Judge, JudgeAnswer, JudgeQuestion } from "../judge.js";
import type { CallGateway } from "../call.js";
import { isPlannedDesign } from "./design.js";
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

/** ②' の JSON Schema の名前 */
export const TEST_SUITE_SCHEMA_NAME = "test-suite";

/** 作り直しの回数（1 回だけやり直す。§1） */
export const TEST_SUITE_ROUNDS = 2;

/**
 * ②' に足す規則の定義（Issue #433）。**送る文は `text` から組む**——段は規則の文を手で持たない。
 * ID は規則の台帳（`workspace/mvp/m1/agent/methodology/ledger/rules.md`）の R-suite-01〜14 を配列の順に
 * 振る（#433 で R-suite-14 を足した）。`why`・`since` は注釈と Issue 番号から写す（空にしない）。
 */
export const TEST_SUITE_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-suite-01",
    text: "原文と要件の一覧だけから、要件ごとの種類（nature）を独立に分類し直す（設計の出力は見せられない）。決まり（条件・計算・検査）を含むなら ruled、在ることだけ（例「名前を持つメンバーを登録できる」）なら existence-only。分類は classifications に入れる。**分類は原文と要件の文だけで決め、確かめ方の欄は使わない。**",
    why: "原文と要件の一覧から種類を独立に分類させる（R2-3）",
    since: "Issue #307",
  },
  {
    id: "R-suite-02",
    text: "確かめ方が structural の要件を除いて、決まりを含む要件は、決まりの役割ごとに、正常・異常・境界の 3 種類の試験を、入力と期待つきで作る。",
    why: "決まりを含む要件に正常・異常・境界の試験を作らせる",
    since: "Issue #307",
  },
  {
    id: "R-suite-03",
    text: "在ることだけの要件は、正常のシナリオ 1 本か、構造の条件（create の操作がある・その entity の一覧か表に項目が出る・画面の部品がある）だけを固定する。**異常・境界の試験や検査（validate）の試験は作らない**。",
    why: "在ることだけの要件に異常・境界の試験を作らせない",
    since: "Issue #307",
  },
  {
    id: "R-suite-04",
    text: "確かめ方が structural の要件には、checks の中身ごとに 1 本以上の**構造の検査だけを作る**。種類（ruled／existence）にかかわらず構造の検査だけを作り、正常・異常・境界の実行の試験（入力・画面・集計・操作の試験）は作らない。構造の検査は操作（operation）を structure にし、assertion に検査の中身を持つ。種類（kind）は normal だけ、期待（expected）は「成り立つ」（kind を ok・value を \"true\"・code を null）にする。",
    why: "構造で確かめる要件には構造の検査だけを固定させる",
    since: "Issue #392",
  },
  {
    id: "R-suite-05",
    text: "構造の検査の assertion.check は、設計の checks の中身（field-type・action-kind・action-unconditioned・view-shows・aggregate-no-period・write-anonymous）と同じ値にする。assertion の expected・refEntity・role は検査の種類に応じて埋める——field-type は expected に項目の種類（string・number・date・list・ref・enum）、参照（ref・参照の並び）なら refEntity に参照先 entity の役割 ID。action-kind は expected に操作の種類（create・update・delete）。view-shows は role に、表示を期待する項目か計算の役割 ID。action-unconditioned・aggregate-no-period・write-anonymous は expected・refEntity・role を null にする。",
    why: "構造の検査の中身と参照の欄の埋め方を、設計の checks に合わせる",
    since: "Issue #386",
  },
  {
    id: "R-suite-06",
    text: "構造の検査は、確かめ方が structural の要件だけを対象にする。構造の検査でない試験は assertion を null にする。確かめ方が structural の要件には、正常・異常・境界のそろいを求めない。",
    why: "構造の検査を構造の要件だけに当て、実行の試験と混ぜさせない",
    since: "Issue #386",
  },
  {
    id: "R-suite-07",
    text: "入力（input）と参照データの値（values）と期待の値（value）は、任意の JSON を表すので、**JSON の文字列**として書く（例: \"{\\\"amount\\\": 21}\"）。",
    why: "任意の JSON を、strict で表せる JSON の文字列として受けさせる（§2）",
    since: "Issue #307",
  },
  {
    id: "R-suite-08",
    text: "異常の期待は、操作ごとの型にする。検査（validate）の異常は誤りコード（expected.code）で確かめ、value は null にする。計算・集計（compute・aggregate）の異常は、値（expected.value）でもよい。それ以外の正常は値の JSON 文字列を value に入れ、code は null にする。",
    why: "異常の期待を操作ごとの型にし、検査と計算を分ける",
    since: "Issue #307",
  },
  {
    id: "R-suite-09",
    text: "対象（target）と参照の行（referenceData の target）は、名前ではなく**役割 ID（roleId）**で指す。役割 ID は ② の役割 ID の表のものを使う。宣言は見られないので、名前を書かない。",
    why: "試験の対象を、宣言の名前ではなく役割 ID で指させる（§1.3）",
    since: "Issue #307",
  },
  {
    id: "R-suite-10",
    text: "入力の契約（inputContract）に、固定の行 ID（rowId）・評価の対象の行 ID（targetRowId。行を評価しないときは null）・空であることを明示する entity の役割 ID（emptyEntities）を入れる。",
    why: "入力の契約（固定の行 ID・評価の対象・空の集合）を書かせる（Issue #322）",
    since: "Issue #307",
  },
  {
    id: "R-suite-11",
    text: "所属 entity の決まったレコードの入力（input）と参照の行の値（values）の直下の鍵は、その entity の項目（kind が field）の役割 ID だけにする。行の ID は inputContract.rowId・referenceData[*].rowId に置き、値の鍵（id・rowId）にしない。この規則は、対象の役割の所属 entity の項目の役割が役割 ID の表にあるときにだけ掛かる。項目の役割の無い表と、役割 ID の表の無い旧形式では、宣言の項目の名前を鍵にしてよい。",
    why: "値の鍵を所属 entity の項目の役割 ID に限り、行の ID を値の鍵に書かせない（Issue #409）",
    since: "Issue #409",
  },
  {
    id: "R-suite-12",
    text: "時計（clock）は固定の日時（オフセット付きの ISO 8601）にする。",
    why: "時計を固定の日時にし、評価を再現できるようにする",
    since: "Issue #307",
  },
  {
    id: "R-suite-13",
    text: "要件 ID は①の一覧のものだけを使う。一覧に無い要件 ID を作らない。",
    why: "一覧に無い要件 ID を作らせない",
    since: "Issue #307",
  },
  {
    id: "R-suite-14",
    text: "選択肢（enum）の項目の値は、役割 ID の表の options から選ぶ。見出しごとの集計の期待は、分ける元の項目の options の全キーを順に、heading と value だけで書き、集計元を読めない入力の期待は null にする。（宣言と固定する試験が別々の表現を推測しないため、選択肢の参照表現と集計元の関係を固定して共有する。）",
    why: "期待の値と見出しを、表（②）の選択肢の参照表現に合わせ、別々の推測をなくす",
    since: "Issue #433",
  },
];

/** ②' に足す規則（共通の規則は buildStructuredRequest が先頭に付ける。定義の `text` から組む） */
export const TEST_SUITE_RULES: readonly string[] = ruleTexts(TEST_SUITE_RULE_DEFINITIONS);

/**
 * ②' の JSON Schema（構造化出力）。**OpenAI の strict の規則に合わせる**（すべての節に `type`、
 * object は `additionalProperties: false` とすべての欄を `required`、任意の欄は null を許す型で表す。§2）。
 *
 * 入力・参照データの値・期待の値は**任意の JSON**（宣言を見る前には形が決まらない）なので、strict で
 * 表せるよう** JSON の文字列**として受ける。コード（`checkTestSuiteOutput`）が読んで値に戻す。
 */
export const TEST_SUITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classifications", "tests"],
  properties: {
    classifications: {
      type: "array",
      description: "原文と要件の一覧から独立に分類した、要件ごとの種類",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "nature"],
        properties: {
          requirementId: { type: "string" },
          nature: { type: "string", enum: [...REQUIREMENT_NATURES] },
        },
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "target",
          "kind",
          "operation",
          "clock",
          "input",
          "inputContract",
          "referenceData",
          "expected",
          "assertion",
        ],
        properties: {
          id: { type: "string" },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["requirementId", "kind", "roleId"],
            properties: {
              requirementId: { type: "string" },
              kind: { type: "string", enum: [...TEST_TARGET_KINDS] },
              roleId: { type: "string", description: "役割 ID（② の役割 ID の表のもの）" },
            },
          },
          kind: { type: "string", enum: [...TEST_KINDS] },
          operation: { type: "string", enum: [...TEST_OPERATIONS] },
          clock: { type: "string" },
          input: { type: "string", description: "入力（レコード）の JSON 文字列" },
          assertion: {
            type: ["object", "null"],
            description: "構造の検査の中身（構造の検査でない試験は null）",
            additionalProperties: false,
            required: ["check", "expected", "refEntity", "role"],
            properties: {
              check: { type: "string", enum: [...STRUCTURAL_ASSERTIONS] },
              expected: {
                type: ["string", "null"],
                description: "field-type は項目の種類、action-kind は操作の種類。ほかの検査は null",
              },
              refEntity: {
                type: ["string", "null"],
                description: "field-type で参照（ref・参照の並び）のときの参照先 entity の役割 ID",
              },
              role: { type: ["string", "null"], description: "view-shows で表示する項目か計算の役割 ID" },
            },
          },
          inputContract: {
            type: "object",
            additionalProperties: false,
            required: ["rowId", "targetRowId", "emptyEntities"],
            properties: {
              rowId: { type: "string", description: "固定の行 ID（入力の行）" },
              targetRowId: {
                type: ["string", "null"],
                description: "評価の対象の行の ID（行を評価しないときは null）",
              },
              emptyEntities: {
                type: "array",
                items: { type: "string" },
                description: "空であることを明示する entity の役割 ID",
              },
            },
          },
          referenceData: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["rowId", "target", "values"],
              properties: {
                rowId: { type: "string", description: "行の ID（固定）" },
                target: {
                  type: "object",
                  additionalProperties: false,
                  required: ["requirementId", "kind", "roleId"],
                  properties: {
                    requirementId: { type: "string" },
                    kind: { type: "string", enum: [...TEST_TARGET_KINDS] },
                    roleId: { type: "string" },
                  },
                },
                values: { type: "string", description: "行の値（項目の役割 → 値）の JSON 文字列" },
              },
            },
          },
          expected: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value", "code"],
            properties: {
              kind: { type: "string", enum: ["ok", "error"] },
              value: { type: ["string", "null"], description: "期待する値の JSON 文字列（kind が error のときは null）" },
              code: { type: ["string", "null"], description: "期待する誤りコード（kind が ok のときは null）" },
            },
          },
        },
      },
    },
  },
} as const;

/** ②' が受け取るもの（要件の一覧だけ。宣言は渡さない） */
export interface TestSuiteInput {
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /**
   * ② の設計。**走らせる部分（`run.ts`）は必ず渡す**（Issue #316）。役割 ID の表と要件ごとの種類を、
   * プロンプトのデータに載せ、分類と突き合わせて（`reconcileNatures`）種類に応じた検査
   * （`checkSuitePlan`）を掛ける。渡されなければ（旧形式の記録）旧来の検査だけを行う（後方互換）。
   */
  readonly design?: DesignResult;
  /**
   * 設計の契約の版（決定 ⑨・Issue #418）。`legacy` を明示したときだけ、過去の記録の読み込みとして
   * 設計の無い旧経路・所属の無い設計を許す。省けば**新契約**——② の設計を必ず渡し、対象と
   * `view-shows` の役割の所属を求める。
   */
  readonly version?: DesignContractVersion;
  /**
   * 確定した仕様（`plan.json`。§5・Issue #334）。渡されたときは、**要件と出どころの正本**として
   * データに載せる（原文の代わりに、確定した仕様の要件と出どころを根拠にする）。
   */
  readonly plan?: ConfirmedPlan;
  /**
   * 判定の口（Jev・LLM・偽物。Issue #373）。渡されたときだけ、**種類が食い違った要件**の種類を
   * 1 回の Choice の呼び出しで選ばせる。生成（`run.ts`）は、予算に結び付けた包みをそのまま渡す
   * （判定の費用は生成の予算と要約の `judge` 欄に入る）。渡さなければ今までどおり `ruled` に倒す。
   */
  readonly judge?: Judge;
  /**
   * 外した（**構造で確かめる要件**の、構造の検査でない）試験を、**回ごとに**受け取る口（§1・②'・
   * Issue #392）。走らせる部分（`run.ts`）はここで受け取り、**②' が最後に失敗しても・後の段で早く
   * 止まっても**要約に残せるようにする（成功の戻り値だけに頼らない）。渡さなければ何もしない。
   */
  readonly onDropped?: (dropped: readonly DroppedNonstructuralTest[]) => void;
}

/** selector の鍵（要件 ID と役割 ID。旧形式の自由な文の役割も受ける） */
function selectorRoleOf(target: TestTarget): string {
  return target.roleId ?? target.role ?? "";
}

/**
 * selector（要件 ID と役割 ID）が一意に決まるかを確かめる。**Problem の `field` は位置（配列の添字と固定の
 * 欄名）、`message` は固定文**（要件 ID・役割 ID・対象の種類の値を埋めない。§1・②'・Issue #439）。
 */
function checkSelectorAmbiguity(list: RequirementList, suite: TestSuite, problems: Problem[]): void {
  const ids = list.requirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) {
    problems.push({ field: "requirements", message: "要件 ID が一覧の中で重なっている（selector が一意に決まらない）" });
  }
  const kindOfSelector = new Map<string, TestTargetKind>();
  suite.tests.forEach((test, index) => {
    const key = `${test.target.requirementId}\u0000${selectorRoleOf(test.target)}`;
    const previous = kindOfSelector.get(key);
    if (previous === undefined) {
      kindOfSelector.set(key, test.target.kind);
      return;
    }
    if (previous !== test.target.kind) {
      problems.push({
        field: `tests[${index}].target`,
        message: "selector（要件 ID と役割 ID）が一意に決まらない（対象の種類が食い違う）",
      });
    }
  });
}

/** 空の試験集合・一覧に無い要件 ID・参照データの行数・selector の一意性を確かめる（種類によらない） */
function checkSuiteBasics(list: RequirementList, suite: TestSuite, problems: Problem[]): void {
  const idSet = new Set(list.requirements.map((requirement) => requirement.id));
  if (suite.tests.length === 0) {
    problems.push({ field: "tests", message: "試験の集合が空である" });
  }
  suite.tests.forEach((test, index) => {
    if (!idSet.has(test.target.requirementId)) {
      problems.push({
        field: `tests[${index}].target.requirementId`,
        message: "一覧に無い要件 ID である",
      });
    }
    const overRows = checkLimit("referenceRowsPerTest", test.referenceData.length);
    if (overRows !== undefined) {
      problems.push({
        field: `tests[${index}].referenceData`,
        message: `参照データの行が上限 ${overRows.max} を超えている（${overRows.actual}）`,
      });
    }
  });
  checkSelectorAmbiguity(list, suite, problems);
}

/**
 * 要件ごとの試験の数と、種類に応じた種類のそろいを確かめる。**Problem の `field` は位置、`message` は
 * 分類ごとの固定文**（要件 ID の値を埋めない。要件ごとの問題は `requirements[添字]`、試験ごとの問題は
 * `tests[添字]` で位置を示す。§1・②'・Issue #439）。
 */
function checkKinds(
  list: RequirementList,
  suite: TestSuite,
  natures: ReadonlyMap<string, RequirementNature>,
  problems: Problem[],
  checkedRequirements: ReadonlySet<string>,
): void {
  list.requirements.forEach((requirement, requirementIndex) => {
    const mine: { readonly test: FixedTest; readonly index: number }[] = [];
    suite.tests.forEach((test, index) => {
      if (test.target.requirementId === requirement.id) mine.push({ test, index });
    });
    if (mine.length === 0) {
      problems.push({ field: `requirements[${requirementIndex}]`, message: "要件の試験が無い" });
      return;
    }
    const overCount = checkLimit("testsPerRequirement", mine.length);
    if (overCount !== undefined) {
      problems.push({
        field: `requirements[${requirementIndex}]`,
        message: `要件の試験が上限 ${overCount.max} を超えている（${overCount.actual}）`,
      });
    }
    // 新形式で構造の検査を作る要件は、正常・異常・境界のそろいを求めない（構造の検査が確かめる。Issue #386）
    if (checkedRequirements.has(requirement.id)) return;
    const nature = natures.get(requirement.id) ?? "ruled";
    if (nature === "existence-only") {
      for (const { test, index } of mine) {
        if (test.kind !== "normal") {
          problems.push({
            field: `tests[${index}]`,
            message: `在ることだけの要件なので、${test.kind} の試験を作らない`,
          });
        }
        if (test.operation === "validate") {
          problems.push({
            field: `tests[${index}]`,
            message: "在ることだけの要件なので、検査（validate）の試験を作らない",
          });
        }
      }
      return;
    }
    const kinds = new Set(mine.map(({ test }) => test.kind));
    for (const kind of TEST_KINDS) {
      if (!kinds.has(kind)) {
        problems.push({ field: `requirements[${requirementIndex}]`, message: `${kind} の試験が無い` });
      }
    }
  });
}

/** 設計の役割 ID の表にある ID の集合 */
export function roleIdsOf(design: DesignResult): ReadonlySet<string> {
  return new Set((design.roles ?? []).map((entry) => entry.roleId));
}

/**
 * 試験の対象・参照の行が、設計の役割 ID で指されているか（自由な文の役割だけなら断る）。**Problem の
 * `field` は位置、`message` は固定文**（役割 ID の値を埋めない。§1・②'・Issue #439）。
 */
function checkRoleIds(suite: TestSuite, roleIds: ReadonlySet<string>, problems: Problem[]): void {
  const check = (target: TestTarget, field: string): void => {
    if (target.roleId === undefined) {
      problems.push({
        field: `${field}.roleId`,
        message: "役割 ID が無い（自由な文の役割だけの試験は固定しない）",
      });
      return;
    }
    if (!roleIds.has(target.roleId)) {
      problems.push({
        field: `${field}.roleId`,
        message: "役割 ID が設計の役割 ID の表に無い",
      });
    }
  };
  suite.tests.forEach((test, index) => {
    check(test.target, `tests[${index}].target`);
    test.referenceData.forEach((row, rowIndex) => {
      check(row.target, `tests[${index}].referenceData[${rowIndex}].target`);
    });
  });
}

/**
 * 行の ID を**値の鍵**に書いたときの理由（②' と ⑤b で同じ文言を使う。§1・②'・Issue #409）。
 * 行の ID は `inputContract.rowId`・`referenceData[*].rowId` に置き、値の鍵（`id`・`rowId`）には書かない。
 */
export function rowIdValueKeyReason(key: string): string {
  return `値の鍵 ${key} は行の ID である（行の ID は rowId に置く。行の ID は inputContract.rowId・referenceData[*].rowId の欄に書く）`;
}

/** 対象の役割の**所属 entity**（entity の役割ならそれ自身、ほかはその所属）。決まらなければ null */
function owningEntityOf(target: TestTarget, roleById: ReadonlyMap<string, RoleEntry>): string | null {
  if (target.kind === "entity") return target.roleId ?? null;
  if (target.roleId === undefined) return null;
  return roleById.get(target.roleId)?.entity ?? null;
}

/**
 * 値の鍵の並びを、所属 entity の**項目（`kind` が `field`）の役割 ID** に照らす（§1・②'・Issue #409）。
 * 鍵は**まず**所属 entity の項目の役割 ID として見る（正当な項目なら、字面が行 ID に似ていても断らない）。
 * 表に無ければ、別の entity の項目の役割 ID・項目でない役割 ID・裸の `id`・`rowId`・表に無い鍵に分けて断る。
 *
 * **Problem の `field` は位置、`message` は分類ごとの固定文**（値の鍵の値・entity の値を埋めない。
 * 裸の `id`・`rowId` だけは固定の語なので理由に残す。§1・②'・Issue #439）。
 */
function checkValueKeysAgainstEntity(
  values: Readonly<Record<string, unknown>>,
  fieldRoleIds: ReadonlySet<string>,
  roleById: ReadonlyMap<string, RoleEntry>,
  field: string,
  problems: Problem[],
): void {
  for (const key of Object.keys(values)) {
    if (fieldRoleIds.has(key)) continue;
    const role = roleById.get(key);
    if (role === undefined) {
      problems.push({
        field,
        message:
          key === "id" || key === "rowId"
            ? rowIdValueKeyReason(key)
            : "値の鍵が、所属 entity の項目の役割 ID の表に無い",
      });
      continue;
    }
    if (role.kind === "field") {
      problems.push({
        field,
        message: "値の鍵が、所属 entity の項目の役割 ID でない（別の entity の項目の役割 ID）",
      });
      continue;
    }
    problems.push({ field, message: "値の鍵が、項目の役割 ID でない" });
  }
}

/**
 * **所属 entity の決まったレコード**の入力と、**参照の行の値**の直下の鍵を、所属 entity の項目の役割 ID に
 * 照らす（§1・②'・Issue #409）。
 *
 *   - 入力は、操作が `compute`・`validate`・`action` で、対象の役割の所属 entity が表で決まるときだけ見る。
 *     `screen`・`structure`・`aggregate` の入力は見ない。写像でない入力は、配列・スカラー・入れ子を一律に
 *     制限せず、⑤b に委ねる
 *   - 計算は、所属 entity が null でないという理由だけでは行のレコードと見なさない。参照の行を持つ計算の
 *     入力は、参照の行だけで評価する計算（精算・アプリ全体・見出しごとの集計）かもしれず、②' が持つ情報
 *     だけではレコードの入力と確かめられないので、入力の鍵を検査しない（⑤b の既存の扱いに委ねる）
 *   - 参照の行の値は、対象の役割の所属 entity（entity の役割ならそれ自身、ほかはその所属）が決まるとき、
 *     すべての試験で見る
 *   - **所属 entity に項目の役割が 1 つも無い表**では掛けない（宣言の項目名を鍵にしてよい互換の経路を
 *     保つ。②' は宣言を知らない）
 *   - 期待（`expected`）の値は検査しない
 */
function checkRecordValueKeys(suite: TestSuite, design: DesignResult, problems: Problem[]): void {
  const roleById = new Map((design.roles ?? []).map((entry) => [entry.roleId, entry]));
  const fieldRoleIdsByEntity = new Map<string, Set<string>>();
  for (const entry of design.roles ?? []) {
    if (entry.kind !== "field" || entry.entity === null) continue;
    const set = fieldRoleIdsByEntity.get(entry.entity) ?? new Set<string>();
    set.add(entry.roleId);
    fieldRoleIdsByEntity.set(entry.entity, set);
  }
  suite.tests.forEach((test, index) => {
    if (test.operation === "compute" || test.operation === "validate" || test.operation === "action") {
      const owner = owningEntityOf(test.target, roleById);
      const fieldRoleIds = owner === null ? undefined : fieldRoleIdsByEntity.get(owner);
      // 計算で参照の行を持つ試験は、レコードの入力と確かめられないので入力の鍵を見ない（⑤b に委ねる）
      const referenceEvaluatedComputation = test.target.kind === "computation" && test.referenceData.length > 0;
      if (owner !== null && fieldRoleIds !== undefined && !referenceEvaluatedComputation && isRecord(test.input)) {
        checkValueKeysAgainstEntity(test.input, fieldRoleIds, roleById, `tests[${index}].input`, problems);
      }
    }
    test.referenceData.forEach((row, rowIndex) => {
      const owner = owningEntityOf(row.target, roleById);
      const fieldRoleIds = owner === null ? undefined : fieldRoleIdsByEntity.get(owner);
      if (owner === null || fieldRoleIds === undefined || !isRecord(row.values)) return;
      checkValueKeysAgainstEntity(
        row.values,
        fieldRoleIds,
        roleById,
        `tests[${index}].referenceData[${rowIndex}].values`,
        problems,
      );
    });
  });
}

/**
 * **選択肢（enum）の項目**の値が、役割 ID の表の `options` の中にあるか（**新契約**。§1・②'・Issue #433）。
 * 直下の鍵が `options` を持つ項目の役割 ID のとき、その値が `options` の中であることを確かめる。
 *
 *   - 入力は、正常・境界の試験だけを、所属 entity が決まるときに見る（`#409` と同じ適用条件。**異常の
 *     試験の入力は検査しない**——拒否を観測する契約が無い）
 *   - 参照の行の値は、行の対象の所属 entity が決まるとき、すべての試験で見る
 *   - **入れ子（直下でない鍵）と、計算の結果は検査しない**
 *   - **所属 entity の選択肢の項目**だけを見る（別 entity の同名の項目は見ない）
 */
function checkOptionValues(suite: TestSuite, design: DesignResult, problems: Problem[]): void {
  const roleById = new Map((design.roles ?? []).map((entry) => [entry.roleId, entry]));
  const optionsByRoleId = new Map<string, readonly string[]>();
  const optionRoleIdsByEntity = new Map<string, Set<string>>();
  for (const entry of design.roles ?? []) {
    if (entry.kind !== "field" || entry.options === null || entry.options === undefined) continue;
    optionsByRoleId.set(entry.roleId, entry.options);
    if (entry.entity !== null) {
      const set = optionRoleIdsByEntity.get(entry.entity) ?? new Set<string>();
      set.add(entry.roleId);
      optionRoleIdsByEntity.set(entry.entity, set);
    }
  }
  if (optionsByRoleId.size === 0) return;
  const checkValues = (values: Readonly<Record<string, unknown>>, owner: string, field: string): void => {
    const ownerOptions = optionRoleIdsByEntity.get(owner);
    if (ownerOptions === undefined) return;
    for (const key of Object.keys(values)) {
      if (!ownerOptions.has(key)) continue;
      const options = optionsByRoleId.get(key);
      if (options === undefined) continue;
      if (!options.includes(values[key] as string)) {
        // **値を埋めない**（止まった記録に漏れる。Issue #433 の管理の指示）
        problems.push({ field, message: "選択肢の項目の値が、その項目の options の外である" });
      }
    }
  };
  suite.tests.forEach((test, index) => {
    const owner = owningEntityOf(test.target, roleById);
    // 計算で参照の行を持つ試験は、レコードの入力と確かめられないので入力の鍵を見ない（⑤b に委ねる）
    const referenceEvaluatedComputation = test.target.kind === "computation" && test.referenceData.length > 0;
    if (
      (test.kind === "normal" || test.kind === "boundary") &&
      (test.operation === "compute" || test.operation === "validate" || test.operation === "action") &&
      owner !== null &&
      !referenceEvaluatedComputation &&
      isRecord(test.input)
    ) {
      checkValues(test.input, owner, `tests[${index}].input`);
    }
    test.referenceData.forEach((row, rowIndex) => {
      const rowOwner = owningEntityOf(row.target, roleById);
      if (rowOwner === null || !isRecord(row.values)) return;
      checkValues(row.values, rowOwner, `tests[${index}].referenceData[${rowIndex}].values`);
    });
  });
}

/**
 * **見出しごとの集計**の期待を、役割 ID の表の `options` に照らす（**新契約**。§1・②'・Issue #433）。
 * 操作が `aggregate` で、対象の計算の役割が `groupBy` を持つ試験の期待は、見出しの並びか `null` を許す。
 * 並びのときは、分ける元の項目の `options` の全キーを**同じ順**に、`heading` と `value` だけの欄で持ち、
 * `value` は数か `null` であること。**結果全体が `null` の期待はそのまま通す**（正しさは ⑤b が確かめる）。
 * `groupBy` が `null` の計算（月・分けない）には掛けない。
 */
function checkAggregateHeadings(suite: TestSuite, design: DesignResult, problems: Problem[]): void {
  const roleById = new Map((design.roles ?? []).map((entry) => [entry.roleId, entry]));
  suite.tests.forEach((test, index) => {
    if (test.operation !== "aggregate") return;
    const roleId = test.target.roleId;
    if (roleId === undefined) return;
    const role = roleById.get(roleId);
    if (role === undefined || role.kind !== "computation" || role.groupBy === null || role.groupBy === undefined) return;
    const groupRole = roleById.get(role.groupBy);
    if (groupRole === undefined || groupRole.kind !== "field" || groupRole.options === null || groupRole.options === undefined) {
      return;
    }
    if (test.expected.kind !== "ok") return;
    const value = test.expected.value;
    if (value === null) return;
    const field = `tests[${index}].expected.value`;
    if (!Array.isArray(value)) {
      problems.push({ field, message: "見出しごとの集計の期待は、見出しの並びか null であること" });
      return;
    }
    const options = groupRole.options;
    if (value.length !== options.length) {
      problems.push({ field, message: "見出しごとの集計の期待は、選択肢（options）の全キーと同じ数であること" });
      return;
    }
    for (let i = 0; i < value.length; i += 1) {
      const entry = value[i];
      if (!isRecord(entry)) {
        problems.push({ field: `${field}[${i}]`, message: "見出しの組は写像（object）であること" });
        return;
      }
      const keys = Object.keys(entry);
      if (keys.length !== 2 || !keys.includes("heading") || !keys.includes("value")) {
        problems.push({ field: `${field}[${i}]`, message: "見出しの組は heading と value だけを持つこと" });
        return;
      }
      if (entry["heading"] !== options[i]) {
        problems.push({ field: `${field}[${i}].heading`, message: "見出しの順が、選択肢（options）の順と合わない" });
        return;
      }
      const itemValue = entry["value"];
      if (itemValue !== null && typeof itemValue !== "number") {
        problems.push({ field: `${field}[${i}].value`, message: "見出しの値は数か null であること" });
        return;
      }
    }
  });
}

/** 異常の期待を、操作ごとの型に照らす（検査は誤りコード。計算・集計は値も許す） */
function checkExpectationKind(suite: TestSuite, problems: Problem[]): void {
  suite.tests.forEach((test, index) => {
    if (test.kind !== "abnormal" || test.operation !== "validate") return;
    if (test.expected.kind !== "error") {
      problems.push({
        field: `tests[${index}].expected`,
        message: "検査（validate）の異常は、誤りコード（expected.code）で確かめる",
      });
    }
  });
}

/**
 * **新形式**で `checks` を持つ、構造で確かめる要件の集合を返す（Issue #386）。`checks` を持つ要件だけが
 * 新しい検査（中身ごとに 1 本）を要求する——`checks` の無い旧形式の設計は、今までどおりの検査になる。
 */
function structuralChecksRequired(design: DesignResult): ReadonlySet<string> {
  const checked = new Set<string>();
  for (const entry of design.designs) {
    if (entry.verification?.kind === "structural" && entry.checks !== undefined) checked.add(entry.requirementId);
  }
  return checked;
}

/**
 * ②' で、**構造で確かめる要件**（`verification.kind` が `structural` で `checks` を持つ）の試験のうち、
 * **構造の検査でない試験**を、固定の前に外した 1 件（§1・②'・Issue #392）。
 *
 * 設計の契約では、構造で確かめる要件は構造の検査だけで確かめ切れる。だから ②' は構造の検査だけを作り、
 * それ以外（入力・画面・集計・操作の実行の試験）を外す。外した件数は**形の検査を通した生成の回ごと**に
 * 数える——同じ ID が別の回で作り直されても回ごとに数え、採用した最終の組の件数とは分ける。
 */
export interface DroppedNonstructuralTest {
  /** 外した回（②' の作り直しの回。1 から数える） */
  readonly round: number;
  /** 外した試験の識別子 */
  readonly testId: string;
  /** その試験が対象にしていた要件 ID（構造で確かめる要件） */
  readonly requirementId: string;
  /** 外した試験の操作（`structure` 以外） */
  readonly operation: TestOperation;
}

/**
 * **構造で確かめる要件**の試験から、**構造の検査でない試験**を、固定の前に外す（§1・②'・Issue #392）。
 * **形の検査（`checkTestSuiteOutput`）を通した応答**に対して、**設計との照合と固定の前**に掛ける純粋な関数
 * である（形の不正な試験は、ここへ来る前に断られている）。
 *
 *   - 対象は、設計が `verification.kind` を `structural` とし `checks` を持つ要件（`structuralChecksRequired`）
 *     の試験だけ。操作が `structure` でないものを外す
 *   - `checks` の無い設計（記録した古い応答）・`fixed-test`・`unresolved` の要件・確かめ方の無い要件は
 *     対象にしない（**何も外さない**）
 *   - **外すのは、その構造の要件を対象にした試験だけ。** 別の要件（`fixed-test` の要件など）の試験は
 *     外さない
 *
 * 外した 1 件ごとに、**回・試験 ID・要件 ID・操作**を返す（回ごとに数える。Issue #392）。外したあとの
 * 検査（構造の検査の欠け・要件の試験の欠け・役割と assertion の形）は、呼ぶ側が今までどおり掛ける。
 */
export function dropNonstructuralTests(
  design: DesignResult,
  suite: TestSuite,
  round: number,
): { readonly suite: TestSuite; readonly dropped: readonly DroppedNonstructuralTest[] } {
  const structural = structuralChecksRequired(design);
  if (structural.size === 0) return { suite, dropped: [] };
  const tests: FixedTest[] = [];
  const dropped: DroppedNonstructuralTest[] = [];
  for (const test of suite.tests) {
    if (test.operation !== "structure" && structural.has(test.target.requirementId)) {
      dropped.push({
        round,
        testId: test.id,
        requirementId: test.target.requirementId,
        operation: test.operation,
      });
      continue;
    }
    tests.push(test);
  }
  if (dropped.length === 0) return { suite, dropped: [] };
  return { suite: { ...suite, tests }, dropped };
}

/**
 * **構造の検査**を、設計（役割 ID の表・確かめ方・checks）に照らして確かめる（§1.3・Issue #386）。
 *
 *   - 構造の検査は、確かめ方が `structural` の要件だけを対象にできる
 *   - 構造の検査の `assertion` が参照する役割（`field-type` の `refEntity`・`view-shows` の `role`）が、
 *     設計の役割 ID の表にあり、種類が合い（entity か、項目か計算か）、対象と同じ entity に属すること
 *   - **新形式**（`checks` を持つ設計）では、`checks` の中身ごとに 1 本以上の構造の検査があること
 *
 * **Problem の `field` は位置（配列の添字と固定の欄名）、`message` は分類ごとの固定文**（要件 ID・役割 ID・
 * entity の値を埋めない。§1・②'・Issue #439）。
 */
function checkStructuralChecks(
  list: RequirementList,
  suite: TestSuite,
  design: DesignResult,
  problems: Problem[],
): void {
  const roleById = new Map((design.roles ?? []).map((entry) => [entry.roleId, entry]));
  const designById = new Map(design.designs.map((entry) => [entry.requirementId, entry]));
  const requirementIndexById = new Map(list.requirements.map((requirement, index) => [requirement.id, index]));
  suite.tests.forEach((test, index) => {
    if (test.operation !== "structure") return;
    const target = designById.get(test.target.requirementId);
    if (target?.verification?.kind !== "structural") {
      problems.push({
        field: `tests[${index}].target`,
        message: "構造の検査は、確かめ方が構造の要件だけを対象にできる",
      });
      return;
    }
    const assertion = test.assertion;
    if (assertion === undefined) return;
    const field = `tests[${index}].assertion`;
    if (assertion.check === "view-shows") {
      const role = assertion.role ?? "";
      const referenced = roleById.get(role);
      if (referenced === undefined) {
        problems.push({ field: `${field}.role`, message: "参照する役割 ID が設計の役割 ID の表に無い" });
        return;
      }
      if (referenced.kind !== "field" && referenced.kind !== "computation") {
        problems.push({
          field: `${field}.role`,
          message: "view-shows の参照する役割は、項目か計算でなければならない",
        });
        return;
      }
      const targetRole = test.target.roleId === undefined ? undefined : roleById.get(test.target.roleId);
      if (targetRole !== undefined && referenced.entity !== targetRole.entity) {
        problems.push({
          field: `${field}.role`,
          message: "view-shows の参照する役割が、対象の役割とは別の entity に属する",
        });
      }
      return;
    }
    if (assertion.check === "field-type" && assertion.refEntity !== undefined) {
      const referenced = roleById.get(assertion.refEntity);
      if (referenced === undefined) {
        problems.push({
          field: `${field}.refEntity`,
          message: "参照する役割 ID が設計の役割 ID の表に無い",
        });
        return;
      }
      if (referenced.kind !== "entity") {
        problems.push({
          field: `${field}.refEntity`,
          message: "field-type の参照先は entity の役割でなければならない",
        });
      }
    }
  });

  // 新形式（checks を持つ設計）では、checks の中身ごとに 1 本以上の構造の検査が要る
  design.designs.forEach((entry, designIndex) => {
    if (entry.verification?.kind !== "structural" || entry.checks === undefined) return;
    const mine = suite.tests.filter(
      (test) => test.target.requirementId === entry.requirementId && test.operation === "structure",
    );
    const have = new Set(mine.map((test) => test.assertion?.check));
    const requirementIndex = requirementIndexById.get(entry.requirementId);
    const field = requirementIndex === undefined ? `designs[${designIndex}]` : `requirements[${requirementIndex}]`;
    for (const check of entry.checks) {
      if (!have.has(check)) {
        problems.push({
          field,
          message: `構造の検査（${check}）が無い（checks の中身ごとに 1 本以上が要る）`,
        });
      }
    }
  });
}

/**
 * 固定する前にコードが確かめる（§1）。合わない欄を**すべて**挙げて返す。役割 ID の検査はしない
 * （旧形式の記録も通すため。新しい設計を渡す `checkSuitePlan` を使う）。
 */
export function checkSuiteAgainstRequirements(list: RequirementList, suite: TestSuite): readonly Problem[] {
  const problems: Problem[] = [];
  checkSuiteBasics(list, suite, problems);
  checkKinds(list, suite, new Map(), problems, new Set());
  return problems;
}

/**
 * **新契約**で、試験の対象の役割 ID と `view-shows` の参照する役割が、その要件の**所属**にあるかを
 * 確かめる（§1・②'・Issue #418）。**参照データの行の対象には所属を求めない**（他の entity の行を
 * 参照する）。Problem の `field` は配列の添字と固定の欄名、`message` は固定文（役割 ID を埋めない）。
 */
function checkOwnedByRequirement(suite: TestSuite, design: DesignResult, problems: Problem[]): void {
  const ownedByRequirement = new Map<string, ReadonlySet<string>>();
  for (const entry of design.designs) {
    ownedByRequirement.set(entry.requirementId, new Set((entry.ownership ?? []).map((ownership) => ownership.roleId)));
  }
  suite.tests.forEach((test, index) => {
    const owned = ownedByRequirement.get(test.target.requirementId);
    if (owned === undefined) return;
    if (test.target.roleId !== undefined && !owned.has(test.target.roleId)) {
      problems.push({
        field: `tests[${index}].target.roleId`,
        message: "対象の役割 ID が、その要件の所属に無い",
      });
    }
    const assertion = test.assertion;
    if (
      assertion !== undefined &&
      assertion.check === "view-shows" &&
      typeof assertion.role === "string" &&
      !owned.has(assertion.role)
    ) {
      problems.push({
        field: `tests[${index}].assertion.role`,
        message: "view-shows の参照する役割が、その要件の所属に無い",
      });
    }
  });
}

/**
 * 設計と分類を突き合わせた結果を、種類に応じて確かめる（§1・②'・Issue #307）。合わない欄を**すべて**返す。
 * `natures` は `reconcileNatures` の結果（設計の種類と ②' の分類を突き合わせた、実際に使う種類）。
 *
 * **新契約**（`version` を省いたとき）では、対象と `view-shows` の役割がその要件の所属にあるかを足す。
 * `legacy` を明示したときは、従来どおり所属を求めない（決定 ⑨・Issue #418）。
 */
export function checkSuitePlan(
  list: RequirementList,
  suite: TestSuite,
  design: DesignResult,
  natures: ReadonlyMap<string, RequirementNature>,
  version?: DesignContractVersion,
): readonly Problem[] {
  const problems: Problem[] = [];
  const checked = structuralChecksRequired(design);
  checkSuiteBasics(list, suite, problems);
  checkKinds(list, suite, natures, problems, checked);
  checkRoleIds(suite, roleIdsOf(design), problems);
  checkExpectationKind(suite, problems);
  checkStructuralChecks(list, suite, design, problems);
  checkRecordValueKeys(suite, design, problems);
  if (version !== LEGACY_DESIGN_CONTRACT) {
    checkOwnedByRequirement(suite, design, problems);
    checkOptionValues(suite, design, problems);
    checkAggregateHeadings(suite, design, problems);
  }
  return problems;
}

/**
 * 食い違った要件の種類を判定の口（Jev → LLM）に選ばせるときの、選んだ選択肢の**確率の閾値**（§1・②'・
 * Issue #373）。**これ以上**なら採り、下なら今までどおり `ruled` に倒す。Plan の判定の閾値
 * （`DEFAULT_PLAN_JUDGE_THRESHOLD`）と同じ考え方で、**版の ID に結び付けて**測り直せるようにする。
 */
export const NATURE_JUDGE_THRESHOLD = 0.6;

/** 上の閾値の版の ID。**版を上げたら測り直す**（記録に残す。§4・S-5・Issue #373） */
export const NATURE_JUDGE_THRESHOLD_VERSION = "nature-judge-v1";

/** 種類の問いの名前の頭（問いの名前は `nature:要件 ID`） */
export const NATURE_QUESTION_PREFIX = "nature";

/** 種類の問いの名前（要件 ID ごとに 1 問） */
export function natureQuestionName(requirementId: string): string {
  return `${NATURE_QUESTION_PREFIX}:${requirementId}`;
}

/** 種類の選択肢（`ruled`／`existence-only`。Choice 1 問の criteria） */
export const NATURE_JUDGE_CRITERIA: Readonly<Record<string, string>> = {
  ruled: "条件・計算・検査などの決まりを含む",
  "existence-only": "在ることだけ（決まりを含まない）",
};

/**
 * 食い違った要件について、判定で採った種類（要件 ID ごとに、1 回の生成の中で 1 度だけ決めて保持する）。
 * `fallback` は今までどおり `ruled` へ倒したこと（判定の口が無い・確率が足りない・失敗した）。
 */
export type NatureDecision =
  | {
      readonly kind: "judged";
      readonly nature: RequirementNature;
      readonly probability: number;
      readonly model: string;
    }
  | { readonly kind: "fallback" };

/** ②' の分類を、② の設計と突き合わせた結果（実際に使う種類と、食い違った要件） */
export interface NatureReconciliation {
  readonly natures: ReadonlyMap<string, RequirementNature>;
  readonly discrepancies: readonly NatureDiscrepancy[];
}

/** ② の設計から、要件ごとの種類を取り出す */
function designNaturesOf(design: DesignResult): ReadonlyMap<string, RequirementNature> {
  const natures = new Map<string, RequirementNature>();
  for (const entry of design.designs) {
    if (entry.nature !== undefined) natures.set(entry.requirementId, entry.nature);
  }
  return natures;
}

/**
 * ②' が独立に分類した種類を、② の設計の種類と突き合わせる（§1・②'・Issue #307・#373）。
 * 食い違った要件は、`decisions` に**判定で採った種類**があればそれを採り、無ければ今までどおり
 * 「決まりを含む」ほうへ倒す（`fallback`）。片方しか無ければそれを採り、どちらも無ければ `ruled`
 * （決まりを含む。見落としを合格にしない側へ倒す）。
 */
export function reconcileNatures(
  design: DesignResult,
  classifications: readonly RequirementClassification[] | undefined,
  decisions?: ReadonlyMap<string, NatureDecision>,
): NatureReconciliation {
  const designNatures = designNaturesOf(design);
  const classified = new Map<string, RequirementNature>();
  for (const entry of classifications ?? []) classified.set(entry.requirementId, entry.nature);
  const natures = new Map<string, RequirementNature>();
  const discrepancies: NatureDiscrepancy[] = [];
  const ids = new Set<string>([...designNatures.keys(), ...classified.keys()]);
  for (const id of ids) {
    const fromDesign = designNatures.get(id);
    const fromClassified = classified.get(id);
    if (fromDesign !== undefined && fromClassified !== undefined && fromDesign !== fromClassified) {
      const decision = decisions?.get(id);
      if (decision !== undefined && decision.kind === "judged") {
        natures.set(id, decision.nature);
        discrepancies.push({
          requirementId: id,
          design: fromDesign,
          classified: fromClassified,
          resolved: decision.nature,
          resolution: "judged",
          probability: decision.probability,
          model: decision.model,
          thresholdVersion: NATURE_JUDGE_THRESHOLD_VERSION,
        });
      } else {
        natures.set(id, "ruled");
        discrepancies.push({
          requirementId: id,
          design: fromDesign,
          classified: fromClassified,
          resolved: "ruled",
          resolution: "fallback",
        });
      }
      continue;
    }
    natures.set(id, fromDesign ?? fromClassified ?? "ruled");
  }
  return { natures, discrepancies };
}

/** いま食い違っている要件 ID（判定の問いを立てる対象。`reconcileNatures` の生の結果から取る） */
function discrepantIdsOf(design: DesignResult, classifications: readonly RequirementClassification[] | undefined): readonly string[] {
  return reconcileNatures(design, classifications).discrepancies.map((entry) => entry.requirementId);
}

/**
 * 判定の答え（choice）から、種類を採るかどうかを決める（§1・②'・Issue #373）。
 * 選択肢が `ruled`／`existence-only` でなく、確率が無い・不正な数・閾値未満のときは `fallback`
 * （`ruled` へ倒す）。**確率がちょうど閾値なら採る**。
 */
function decideNature(answer: JudgeAnswer | undefined, model: string): NatureDecision {
  if (answer === undefined || answer.kind !== "choice") return { kind: "fallback" };
  if (!isRequirementNature(answer.choice)) return { kind: "fallback" };
  const probability = answer.probability;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    return { kind: "fallback" };
  }
  if (probability < NATURE_JUDGE_THRESHOLD) return { kind: "fallback" };
  return { kind: "judged", nature: answer.choice, probability, model };
}

/**
 * 食い違った要件を、**1 回の呼び出しにまとめて**判定の口に聞く（§1・②'・Issue #373）。
 * state は**要件の文と原文の引用だけ**（設計の出力・試験は渡さない）。答えが無い・確率が足りない・
 * 判定が失敗した要件は `fallback`（`ruled` へ倒す）。**要件ごとに 1 度だけ**聞くので、呼ぶ側は
 * 決めた結果を保持し、やり直しの回で聞き直さない。
 */
export async function decideDiscrepantNatures(input: {
  readonly judge: Judge;
  readonly list: RequirementList;
  readonly requirementIds: readonly string[];
}): Promise<ReadonlyMap<string, NatureDecision>> {
  const decisions = new Map<string, NatureDecision>();
  if (input.requirementIds.length === 0) return decisions;
  const questions: Record<string, JudgeQuestion> = {};
  for (const requirementId of input.requirementIds) {
    const requirement = input.list.requirements.find((candidate) => candidate.id === requirementId);
    questions[natureQuestionName(requirementId)] = {
      kind: "choice",
      instructions: {
        // 対象の要件の文と原文の引用を問いの欄に載せる（問いの名前だけでは Jev が読めない。Issue #376）
        requirement: requirement?.text ?? "",
        quote: requirement?.quote ?? "",
        ask: "Does the target requirement contain rules (conditions, calculations, validations), or is it only about existence? Choose ruled if it contains rules, existence-only if it is only about existence.",
      },
      criteria: NATURE_JUDGE_CRITERIA,
    };
  }
  let model = "";
  let answers: Readonly<Record<string, JudgeAnswer>> | undefined;
  try {
    // state には、問いをまたいで共通に要るものは無い（対象の文は問いの欄へ移した。Issue #376）
    const response = await input.judge.judge({ state: {}, questions });
    model = response.model;
    answers = response.answers;
  } catch {
    // 判定が失敗したら（予算の予約が断られたときも含む）、食い違った要件はすべて ruled へ倒す
    for (const requirementId of input.requirementIds) decisions.set(requirementId, { kind: "fallback" });
    return decisions;
  }
  for (const requirementId of input.requirementIds) {
    decisions.set(requirementId, decideNature(answers[natureQuestionName(requirementId)], model));
  }
  return decisions;
}

/**
 * 採った種類を、試験集合の分類（`classifications`）に書き込む（§1・②'・Issue #373）。
 * 後の段（試験の実行・直す段）が、②' で検査したのと同じ種類で評価できるようにする。
 */
function withAdoptedNatures(
  suite: TestSuite,
  adopted: ReadonlyMap<string, RequirementNature>,
): TestSuite {
  if (adopted.size === 0) return suite;
  const out: RequirementClassification[] = [];
  const seen = new Set<string>();
  for (const entry of suite.classifications ?? []) {
    out.push({ requirementId: entry.requirementId, nature: adopted.get(entry.requirementId) ?? entry.nature });
    seen.add(entry.requirementId);
  }
  for (const [requirementId, nature] of adopted) {
    if (!seen.has(requirementId)) out.push({ requirementId, nature });
  }
  return { ...suite, classifications: out };
}

/**
 * 任意の JSON を表す文字列なら、読んで値に戻す（strict の schema に合わせて文字列で受けるため。§2）。
 * 文字列でなければそのまま返す（記録した試験の fixture は、そのままの値で渡ってくる）。
 */
function decodeJsonValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 生の試験 1 件の、任意の JSON を表す欄（input・referenceData の values・expected の value）を値に戻す */
function decodeTest(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const test: Record<string, unknown> = { ...raw };
  if ("input" in test) test["input"] = decodeJsonValue(test["input"]);
  const rawRows = test["referenceData"];
  if (Array.isArray(rawRows)) {
    test["referenceData"] = rawRows.map((row) =>
      isRecord(row) && "values" in row ? { ...row, values: decodeJsonValue(row["values"]) } : row,
    );
  }
  const rawExpected = test["expected"];
  if (isRecord(rawExpected) && "value" in rawExpected) {
    test["expected"] = { ...rawExpected, value: decodeJsonValue(rawExpected["value"]) };
  }
  return test;
}

/** 分類の並びの形を確かめる（新しい欄。旧形式の記録では省ける） */
function checkClassifications(value: unknown, problems: Problem[]): readonly RequirementClassification[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ field: "classifications", message: "分類の並び（array）であること" });
    return undefined;
  }
  const classifications: RequirementClassification[] = [];
  let good = true;
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push({ field: `classifications[${index}]`, message: "分類は写像（object）であること" });
      good = false;
      return;
    }
    const requirementId = item["requirementId"];
    if (typeof requirementId !== "string" || requirementId === "") {
      problems.push({ field: `classifications[${index}].requirementId`, message: "要件 ID は空でない文字列であること" });
      good = false;
    }
    const nature = item["nature"];
    if (!isRequirementNature(nature)) {
      problems.push({
        field: `classifications[${index}].nature`,
        message: `種類は ${REQUIREMENT_NATURES.join("・")} のいずれかであること`,
      });
      good = false;
      return;
    }
    classifications.push({ requirementId: requirementId as string, nature });
  });
  return good ? classifications : undefined;
}

/** ②' の応答の形を確かめる（欄の形は fixed-test.ts の `checkTestSuite` が正本） */
export function checkTestSuiteOutput(output: unknown): ShapeCheck<TestSuite> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const tests = output["tests"];
  if (!Array.isArray(tests)) {
    return { ok: false, problems: [{ field: "tests", message: "試験の一覧は並び（array）であること" }] };
  }
  const problems: Problem[] = [];
  let classifications: readonly RequirementClassification[] | undefined;
  if ("classifications" in output) {
    classifications = checkClassifications(output["classifications"], problems);
  }
  const checked = checkTestSuite(tests.map(decodeTest));
  if (!checked.ok) {
    return { ok: false, problems: [...problems, ...checked.problems] };
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: { tests: checked.suite.tests, ...(classifications === undefined ? {} : { classifications }) },
  };
}

/**
 * **新契約**の設計の形を満たすか（決定 ⑨・Issue #428）。役割 ID の表を持ち、要件ごとに種類（nature）と
 * 確かめ方（verification）を持つこと。**中身の正しさはここで見ない**——所属の点検・役割 ID の検査・
 * 構造の検査は `checkSuitePlan` が別に掛ける。ここは「新契約で渡された設計が、新契約の必須の欄を
 * 備えているか」だけを点検する。**欄の有無から版を推定しない**——版は呼ぶ側の明示で決まるので、
 * `isPlannedDesign` は `legacy` を明示したときだけ使う。
 */
function isNewContractDesign(design: DesignResult): boolean {
  if (design.roles === undefined) return false;
  return design.designs.every((entry) => entry.nature !== undefined && entry.verification !== undefined);
}

/**
 * **新契約**の役割 ID の表の `groupBy` を確かめる（Issue #433・review 1）。`checkSuitePlan` の見出しの
 * 検査は、**欄が無い（欠落）**を `null` と同じく対象外にする。だから、入口で欠落・形・参照先の不備を
 * 断らないと、この欄だけを欠かせた設計が、見出しの検査を省いたまま固定できてしまう（#428 が設けた
 * 「入力が欠けても旧来の検査だけで固定しない」の境界に、#433 の欄を反映する）。
 *
 *   - 欠落（欄が無い）… 新契約では必須（計算でなければ `null` を書く）。**`null` は対象外であって不備ではない**
 *   - 計算でない役割の非 null／空でない文字列でない
 *   - 参照先の役割 ID が表に無い・項目（`field`）でない・選択肢（`options`）が無い
 *   - 有無の混在
 *
 * **Problem の `field`・`message` に値を埋めない**。`legacy` を明示したときは掛けない（呼ぶ側が分ける）。
 */
function checkRoleGroupByFields(design: DesignResult): readonly Problem[] {
  const problems: Problem[] = [];
  const roles = design.roles ?? [];
  const roleById = new Map(roles.map((role) => [role.roleId, role]));
  let present = 0;
  roles.forEach((role, index) => {
    const field = `roles[${index}].groupBy`;
    if (role.groupBy === undefined) {
      problems.push({ field, message: "見出しの元の項目の欄（groupBy）が要る（計算でなければ null）" });
      return;
    }
    present += 1;
    if (role.groupBy === null) return;
    if (typeof role.groupBy !== "string" || role.groupBy === "") {
      problems.push({ field, message: "見出しの元の項目は空でない文字列か null であること" });
      return;
    }
    if (role.kind !== "computation") {
      problems.push({ field, message: "計算でない役割の見出しの元の項目は null であること" });
      return;
    }
    const target = roleById.get(role.groupBy);
    if (target === undefined) {
      problems.push({ field, message: "見出しの元の項目の役割 ID が役割 ID の表に無い" });
      return;
    }
    if (target.kind !== "field") {
      problems.push({ field, message: "見出しの元の項目が項目（field）でない" });
      return;
    }
    if (target.options === null || target.options === undefined) {
      problems.push({ field, message: "見出しの元の項目に選択肢（options）が無い" });
    }
  });
  if (present > 0 && present < roles.length) {
    problems.push({ field: "roles", message: "見出しの元の項目（groupBy）の有無が役割ごとに混ざっている" });
  }
  return problems;
}

/**
 * ②' のデータ（要件の一覧。やり直しのときは前回の作り直しの指示を足す）。
 *
 * **② の設計が渡されたときは、役割 ID の表と要件ごとの種類も入れる**（Issue #316）。②' は宣言を
 * 見せられないので、試験の対象を指す役割 ID は ② の表から受け取る（自由な文の名前は宣言を見ないと
 * 決まらない）。種類も渡すのは、コードの突き合わせ（`reconcileNatures`）と同じ材料を会話にも見せ、
 * 在ることだけの要件に異常・境界の試験を作らせないためである。
 *
 * **やり直しでは、前回に実際に検査した試験集合（構造で確かめる要件の実行の試験を外した後）も、
 * 前回の作り直しの指示とは別のデータとして渡す**（Issue #439）。Problem の `field` は位置を添字で
 * 示す（`tests[添字]`）が値を文に埋めないので、その添字がどの試験を指すかは、この集合が無いと
 * 解決できない。`requirements[添字]` は毎回送る要件の一覧に対応するので、この集合は要らない。
 *
 * **版は呼ぶ側の明示でだけ決める**（欄の有無から推定しない。決定 ⑨・Issue #428）。新契約（`version` を
 * 省いたとき）は、設計の欄（役割 ID の表・種類・確かめ方・所属）が無くても**必ず** 4 つを入れる
 * （黙って省かない。無ければ空の並び）。`legacy` を明示したときだけ `isPlannedDesign` で決め、
 * 役割 ID の表を持たない旧形式の記録では入れない（後方互換）。
 */
function buildData(
  list: RequirementList,
  design: DesignResult | undefined,
  previous: readonly Problem[],
  previousTests: readonly FixedTest[] | undefined,
  plan: ConfirmedPlan | undefined,
  version: DesignContractVersion | undefined,
): readonly PromptData[] {
  const data: PromptData[] = [{ name: "要件の一覧", text: serializeJson(list) }];
  if (plan !== undefined) {
    data.push({ name: "確定した仕様", text: serializeJson(plan) });
  }
  const legacy = version === LEGACY_DESIGN_CONTRACT;
  if (legacy ? design !== undefined && isPlannedDesign(design) : true) {
    const designs = design?.designs ?? [];
    data.push({ name: "役割 ID の表", text: serializeJson(design?.roles ?? []) });
    data.push({
      name: "要件ごとの種類",
      text: serializeJson(
        [...(design === undefined ? [] : designNaturesOf(design))].map(([requirementId, nature]) => ({
          requirementId,
          nature,
        })),
      ),
    });
    // 確かめ方（求める検査の形＝checks と、確かめ方の種類＝verification.kind）は、種類の分類とは
    // **別のデータの欄**で渡す（Issue #386・#392。分類は原文と要件の文だけで決めさせ、確かめ方の欄は
    // 使わせない）。空の checks は構造で確かめない。種類（verificationKind）が structural の要件には、
    // 構造の検査だけを作らせる（Issue #392）。
    data.push({
      name: "要件ごとの確かめ方",
      text: serializeJson(
        designs.map((entry) => ({
          requirementId: entry.requirementId,
          verificationKind: entry.verification?.kind ?? null,
          checks: entry.checks ?? [],
        })),
      ),
    });
    // 要件ごとの所属（根拠つき。Issue #418）。試験の対象の役割 ID は、その要件の所属から選ばせる。
    data.push({
      name: "要件ごとの所属",
      text: serializeJson(
        designs.map((entry) => ({
          requirementId: entry.requirementId,
          ownership: entry.ownership ?? [],
        })),
      ),
    });
  }
  if (previous.length > 0) {
    // 前回に実際に検査した試験集合を、作り直しの指示とは**別のデータ**として渡す（Issue #439）。
    // 作り直しの指示の `tests[添字]` は、この集合の添字を指す（値を Problem の文に戻さない）。
    if (previousTests !== undefined) {
      data.push({ name: "前回の試験", text: serializeJson(previousTests) });
    }
    data.push({ name: "前回の作り直しの指示", text: serializeJson(previous) });
  }
  return data;
}

/** ②' の結果（固定した試験の組と、やり直した回数、設計と食い違った種類） */
export interface TestSuiteValue {
  readonly suite: TestSuite;
  readonly rounds: number;
  /**
   * ②' の分類と ② の設計が食い違った要件（どう決めたかと、判定で選んだときは確率つき。
   * §1・②'・Issue #307・#373）
   */
  readonly discrepancies: readonly NatureDiscrepancy[];
  /**
   * 固定の前に外した、**構造で確かめる要件の構造の検査でない試験**（回・試験 ID・要件 ID・操作。
   * §1・②'・Issue #392）。**回ごとに数える**——やり直しの回で外した分も入る（採用した最終の組の件数
   * とは分ける）。外していなければ空の並びである。
   */
  readonly dropped: readonly DroppedNonstructuralTest[];
}

/**
 * ②' を回す。形は `callStructuredChecked` が 1 回だけやり直し、コードの検査に合わなければ
 * **1 回だけ作り直させる**。設計が渡されたときは、分類との食い違いを突き合わせ、**食い違った要件だけ**
 * を判定の口に 1 回の Choice で選ばせ（`decideDiscrepantNatures`）、種類に応じた検査（`checkSuitePlan`）
 * を掛ける。それでも合わなければ `unmet`（未達）として、欠けの内容を返す。
 *
 * **同じ要件は 1 回の生成の中で 1 度だけ聞く**——決めた結果（`decisions`）をやり直しの回へ持ち越すので、
 * 分類が変わっても聞き直さず、失敗した要件も聞き直さない（Issue #373）。
 */
export async function runTestSuite(input: TestSuiteInput): Promise<StageOutcome<TestSuiteValue>> {
  const legacy = input.version === LEGACY_DESIGN_CONTRACT;
  // **版は欄の有無から推定しない。** 新契約（`version` を省いたとき）では、② の設計を必ず渡す。設計が
  // 役割 ID の表・種類・確かめ方を持たなくても、旧来の検査（`checkSuiteAgainstRequirements`）へ落とさず、
  // **中身の点検で断る**（`designProblem` と同じ扱いで `unmet`。要求は今までどおり送る。Issue #418・#428）。
  // 新契約の形（役割 ID の表・種類・確かめ方）を持つときも、#433 の欄（役割ごとの `groupBy`）の欠落・
  // 形・参照先の不備を入口で断る——見出しの検査は欠落を対象外にするので、ここで断らないと欄だけを
  // 欠かせた設計が固定できてしまう（Issue #433・review 1）。`isPlannedDesign` は `legacy` を明示したときだけ使う。
  const designProblem: readonly Problem[] = legacy
    ? []
    : input.design === undefined
      ? [
          {
            field: "design",
            message:
              "新契約では、役割 ID の表・要件ごとの種類・確かめ方を持つ ② の設計が要る（無い・欠ける入力は断る）",
          },
        ]
      : isNewContractDesign(input.design)
        ? checkRoleGroupByFields(input.design)
        : [
            {
              field: "design",
              message:
                "新契約では、役割 ID の表・要件ごとの種類・確かめ方を持つ ② の設計が要る（無い・欠ける入力は断る）",
            },
          ];
  let previous: readonly Problem[] = [];
  // **前回に実際に検査した試験集合**（構造で確かめる要件の実行の試験を外した後）。作り直しの指示の
  // `tests[添字]` の参照先になる。Problem の文に値を戻さずに位置を解決できるように、別のデータとして渡す
  // （Issue #439）。
  let previousTests: readonly FixedTest[] | undefined;
  // 食い違った要件の決め方（要件 ID ごと）。やり直しの回をまたいで持ち越す（聞き直さない。Issue #373）
  const decisions = new Map<string, NatureDecision>();
  // 固定の前に外した、構造で確かめる要件の構造の検査でない試験（回ごとに数える。Issue #392）
  const droppedAll: DroppedNonstructuralTest[] = [];
  // 経路を分けるのは**版**だけである（欄の有無から推定しない。Issue #428）。新契約では、設計が渡されれば
  // （役割 ID の表・種類・確かめ方を持たなくても）必ず中身の点検の経路へ通す。`legacy` を明示したときだけ
  // `isPlannedDesign` で旧形式の記録を旧来の検査へ通す（設計が無い・新形式の欄を持たないとき）。
  const planned = input.design !== undefined && (!legacy || isPlannedDesign(input.design));
  for (let round = 1; round <= TEST_SUITE_ROUNDS; round += 1) {
    const request = buildStructuredRequest({
      rules: TEST_SUITE_RULES,
      documents: input.documents,
      data: buildData(input.list, input.design, previous, previousTests, input.plan, input.version),
      schemaName: TEST_SUITE_SCHEMA_NAME,
      schema: TEST_SUITE_SCHEMA,
      maxOutputTokens: input.gateway.maxOutputTokens("test-suite"),
    });
    const answer = await callStructuredChecked(input.gateway, { request, check: checkTestSuiteOutput });
    if (!answer.ok) return answer;
    let problems: readonly Problem[];
    let discrepancies: readonly NatureDiscrepancy[] = [];
    let suite = answer.value;
    if (input.design === undefined || !planned) {
      problems = [...designProblem, ...checkSuiteAgainstRequirements(input.list, answer.value)];
    } else {
      // 食い違った要件のうち、まだ決めていないものを 1 回の呼び出しにまとめて判定に聞く（Issue #373）。
      // 判定の口が無ければ聞かず、`reconcileNatures` が今までどおり `ruled` に倒す。
      if (input.judge !== undefined) {
        const pending = discrepantIdsOf(input.design, answer.value.classifications).filter(
          (requirementId) => !decisions.has(requirementId),
        );
        if (pending.length > 0) {
          const verdicts = await decideDiscrepantNatures({
            judge: input.judge,
            list: input.list,
            requirementIds: pending,
          });
          for (const [requirementId, decision] of verdicts) decisions.set(requirementId, decision);
        }
      }
      const reconciled = reconcileNatures(input.design, answer.value.classifications, decisions);
      discrepancies = reconciled.discrepancies;
      // **構造で確かめる要件**の、構造の検査でない試験を、照合と固定の前に外す（§1・②'・Issue #392）。
      // 外した分は回ごとに数え、成功の戻り値だけでなく通知の口でも渡す（後の段で早く止まっても要約に残す）。
      const dropResult = dropNonstructuralTests(input.design, answer.value, round);
      if (dropResult.dropped.length > 0) {
        for (const entry of dropResult.dropped) droppedAll.push(entry);
        input.onDropped?.(dropResult.dropped);
      }
      // 採った種類を、返す試験集合の分類にも書き込む（後の段が同じ種類で評価できるように。Issue #373）
      const adopted = new Map<string, RequirementNature>();
      for (const entry of reconciled.discrepancies) adopted.set(entry.requirementId, entry.resolved);
      suite = withAdoptedNatures(dropResult.suite, adopted);
      // 新契約で設計が必須の欄を欠くときは `designProblem` を先頭に残す（中身の点検もあわせて掛ける。Issue #428）
      problems = [...designProblem, ...checkSuitePlan(input.list, suite, input.design, reconciled.natures, input.version)];
    }
    if (problems.length === 0) {
      return { ok: true, value: { suite, rounds: round, discrepancies, dropped: droppedAll } };
    }
    // 次の回に、作り直しの指示と**その添字の参照先**（実際に検査した試験集合）を渡す（Issue #439）
    previous = problems;
    previousTests = suite.tests;
    // 中身の点検に落ちたので作り直す。この**中身のやり直し**を、共通の口へ告げる（Issue #446）。
    if (round < TEST_SUITE_ROUNDS) input.gateway.noteRetry("content");
  }
  return { ok: false, failure: { kind: "unmet", attempts: TEST_SUITE_ROUNDS, problems: previous } };
}
