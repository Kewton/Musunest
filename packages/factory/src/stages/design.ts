// ② 設計する（02-architecture.md §1・F-4・F-5・F-7・F-8・Issue #307・#332）。
//
// 要件ごとに、使う語彙と置き場所、そして**書けない部分**を返す。書けない部分は、その部分だけを
// 落とし、残りの書ける部分は残す設計にさせる（F-4）。無い語彙・キー・関数を作らせない（F-5）。
// ② には要件の一覧だけを渡す（宣言はまだ無い）。
//
// Issue #307 で、② の出力に次を足した（疎通の確認で、固定した試験が宣言の要素に結び付かなかった）：
//   - **役割 ID の表**（entity の文脈を含む ID・対象の種類・所属の entity。共有と別名は明示の欄でだけ許す）
//   - 要件ごとの**種類**（決まりを含む／在ることだけ）と**確かめ方**（固定した試験／構造の条件／未解決）
//
// Issue #332 で、**誤った「書けない」の申告**を直すために、② の出力の形を変えた：
//   - `unwritable` の要素を、文字列から「書けない部分（part）・**制約 ID**（constraintIds）・理由（reason）」
//     の組にした（制約 ID は、渡した文書の本文から取った集合——契約の規則の `R-…` と語彙の意味の `### ` 見出し
//     ——に入っていなければ、`checkDesignConstraints` が断る）
//   - 曖昧さ・決めたこと・不確かさは、新しい欄 `notes` に書かせる（`unwritable` に混ぜない）
//   - 書けない部分があっても、書ける部分は設計に残す（F-4）
//
// 形（`checkDesignOutput`）と**中身の点検**（`checkDesignPlan`・`checkDesignConstraints`）を分ける。形の
// 確認は旧形式の記録（役割 ID の表・種類・確かめ方が無い、`unwritable` が文字列）も通す（後方互換）。
// 中身の点検は、新しい欄を持つ設計にだけ掛ける（`isPlannedDesign`）——旧形式の記録を壊さず、新しい設計は
// 必須の欄を満たすことを強制する。
import type {
  DesignResult,
  DesignContractVersion,
  RequirementDesign,
  RequirementList,
  RequirementVerification,
  RoleEntry,
  RoleOwnership,
} from "../pipeline.js";
import { LEGACY_DESIGN_CONTRACT, REQUIREMENT_VERIFICATION_KINDS, ROLE_OWNERSHIP_BASES } from "../pipeline.js";
import {
  REQUIREMENT_NATURES,
  STRUCTURAL_ASSERTIONS,
  TEST_TARGET_KINDS,
  isRequirementNature,
  isStructuralAssertionKind,
  type StructuralAssertionKind,
} from "../fixed-test.js";
import type { CallGateway } from "../call.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  checkStringArray,
  constraintIdsIn,
  isRecord,
  normalizeConstraintId,
  normalizeConstraintIds,
  ruleTexts,
  serializeJson,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RuleDefinition,
  type ShapeCheck,
  type StageOutcome,
} from "./prompt.js";

/** ② の JSON Schema の名前 */
export const DESIGN_SCHEMA_NAME = "requirement-design";

/**
 * 作り直し（`redoDesign`）だけに足す規則の定義（配列の外。Issue #418・#433）。元の全役割の表を
 * **固定の文脈**として渡し、役割 ID を足し引きさせない（表は呼ぶ側が持つ。応答は対象の要件 1 件の設計だけ）。
 */
export const REDO_DESIGN_FIXED_TABLE_DEFINITION: RuleDefinition = {
  id: "R-design-redo",
  text: "役割 ID の表は固定の文脈である。作り直しでは、役割 ID を足したり変えたりしない（表の行の増減・欄の違い・options の変更をしない）。応答には、対象の要件 1 件の設計だけを返す。",
  why: "作り直しで役割の表を持ち越し、表の増減や欄・options の変更で整合を壊さないため",
  since: "Issue #418",
};

/** 作り直しにだけ足す規則（定義の `text`。Issue #418） */
export const REDO_DESIGN_FIXED_TABLE_RULE: string = REDO_DESIGN_FIXED_TABLE_DEFINITION.text;

/** 作り直しの回数（1 回だけやり直す。§1）。試験の段（`TEST_SUITE_ROUNDS`）と同じ形 */
export const DESIGN_ROUNDS = 2;

/**
 * ② に足す規則の定義（Issue #433）。**送る文は `text` から組む**——段は規則の文を手で持たない。
 * ID は規則の台帳（`workspace/mvp/m1/agent/methodology/ledger/rules.md`）のものを使う（配列の順と ID の
 * 順は違ってよい）。`why`・`since` は注釈と Issue 番号から写す（空にしない）。ID の重複・why・since の
 * 欠落は `ruleDefinitionDefects` で確かめる。
 */
export const DESIGN_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-design-01",
    text: "要件ごとに、使う語彙と、宣言のどの欄に置くか（placement）を決める。",
    why: "要件ごとに語彙と置き場所を決めさせる（F-4）",
    since: "Issue #292",
  },
  {
    id: "R-design-02",
    text: "書けない部分は、その部分（part）だけを unwritable に挙げる。1 件は「書けない部分（part）・根拠にした制約 ID（constraintIds）・理由（reason）」の組にする。書ける部分は残す（部分的に書けない要件でも、書ける部分は書く）。",
    why: "誤った「書けない」の申告を、部分・制約 ID・理由の組にして裏を取れるようにする",
    since: "Issue #332",
  },
  {
    id: "R-design-03",
    text: "制約 ID は、渡した文書の本文にあるものだけを挙げる——契約の規則の ID（例 `R-TYPE-01`）か、語彙の意味の見出しの文（例 `number`。`#` の記号は付けない）である。文書に無い ID を作らない。",
    why: "書けない申告の制約 ID を、渡した文書にあるものだけに限る",
    since: "Issue #332",
  },
  {
    id: "R-design-04",
    text: "語彙の穴ではないもの（曖昧さ・決めたこと・不確かさ・要件の言い直し）は unwritable に書かず、notes に書く。notes には書けない部分を書かない。",
    why: "書けないことではないもの（曖昧さ・決めたこと）を notes に分ける",
    since: "Issue #332",
  },
  {
    id: "R-design-05",
    text: "文書（契約・語彙の意味・語彙の台帳）に無い語彙・キー・関数は作らない。書けないものを、近い別の意味に書き換えない。",
    why: "無い語彙・キー・関数を作らせず、近い別の意味への書き換えを禁じる（F-5）",
    since: "Issue #292",
  },
  {
    id: "R-design-06",
    text: "要件ごとに 1 つの設計を返す。要件 ID は一覧のまま写す。**代わりの案の要件にも 1 つ設計を返す**（一覧の中の `R:alt:` の形の要件 ID も、一覧のまま写して設計を返す）。",
    why: "代わりの案の要件にも 1 つ設計を返させる",
    since: "Issue #407",
  },
  {
    id: "R-design-07",
    text: "役割 ID の表（roles）を作る。役割 ID は entity の文脈を含む ID（例 member・member.name・session.bookCount）にし、対象の種類（kind）と、所属の entity の役割 ID（entity）を付ける。entity 自身の行は entity を null にする。",
    why: "役割 ID の表（entity の文脈・種類・所属）を作らせる",
    since: "Issue #307",
  },
  {
    id: "R-design-08",
    text: "同じ名前の対象を複数の役割 ID にするときは、共有（shared を true）か別名（aliasOf を元の役割 ID）を明示する。明示しなければ、同じ名前の対象を 1 つの役割 ID にまとめる。",
    why: "共有か別名を明示させ、同名の対象を勝手に分けさせない（R2-8）",
    since: "Issue #307",
  },
  {
    id: "R-design-09",
    text: "同名の別 entity を同じ役割 ID にしない。別 entity の同名の対象は、別の役割 ID にする。",
    why: "同名の別 entity を同じ役割 ID に潰させない（R2-8）",
    since: "Issue #307",
  },
  {
    id: "R-design-18",
    text: "要件ごとに、その要件が使う役割の所属（ownership）を挙げる。要件の文が名指しする役割は basis を stated にして reason を null にする。要件の実現に必要な依存（参照・識別・表示・入力の保存など）として使う役割は basis を dependency にして、その必要の根拠（reason）を空でない文で書く。",
    why: "要件ごとに使う役割の所属（stated／dependency と根拠）を挙げさせる",
    since: "Issue #418",
  },
  {
    id: "R-design-19",
    text: "名前だけの項目（entity の項目）も、参照・識別・表示に要るなら、その要件に dependency として根拠つきで所属させる。",
    why: "必要な依存として、名前だけの項目にも根拠つきで所属させる",
    since: "Issue #418",
  },
  {
    id: "R-design-20",
    text: "根拠の無い役割を役割 ID の表に残さない。どの要件にも所属しない役割があると、その設計は未達になる。",
    why: "根拠の無い役割を表に残させない（未達にする）",
    since: "Issue #418",
  },
  {
    id: "R-design-21",
    text: "役割を都合の良い要件へ付け替えない。表の役割は、その役割を実際に使う要件に所属させる。",
    why: "点検の省略や付け替えで通させない（所有者の決定）",
    since: "Issue #418",
  },
  {
    id: "R-design-22",
    text: "選択肢（enum）の項目は、宣言で使う順の、空でない重複の無いキーの並びを options に書く。それ以外の役割の options は null にする。",
    why: "選択肢の項目に、宣言で使う順のキー列を書かせる（M-06）",
    since: "Issue #418",
  },
  {
    id: "R-design-23",
    text: "見出しごとの集計の計算は、分ける元の選択肢の項目の役割 ID を groupBy に書き、それ以外の役割の groupBy は null にする。（宣言と固定する試験が別々の表現を推測しないため、選択肢の参照表現と集計元の関係を固定して共有する。）",
    why: "見出しの元の項目を持ち主（②）に持たせ、宣言と期待の推測をなくす",
    since: "Issue #433",
  },
  {
    id: "R-design-10",
    text: "要件ごとに、種類（nature）を決める。決まり（条件・計算・検査）を含むなら ruled、在ることだけ（例「名前を持つメンバーを登録できる」）なら existence-only。",
    why: "要件ごとに種類（決まりを含む／在ることだけ）を決めさせる（F1・R2-3）",
    since: "Issue #307",
  },
  {
    id: "R-design-11",
    text: "要件ごとに、確かめ方（verification）を決める。固定した試験で確かめるなら fixed-test、構造の条件で確かめるなら structural、いまは確かめられないなら unresolved。fixed-test 以外は reason（理由）を書く。",
    why: "確かめ方と、試験を作らないときの理由を決めさせる",
    since: "Issue #307",
  },
  {
    id: "R-design-12",
    text: "確かめ方が structural の要件は、求める構造の検査の中身（checks）を、field-type・action-kind・action-unconditioned・view-shows・aggregate-no-period・write-anonymous から、重ならずに挙げる。挙げられない条件があるなら structural にしない。構造で確かめない要件の checks は空にする。",
    why: "構造で確かめる要件の checks を重ならずに挙げさせる（M-08 関連）",
    since: "Issue #386",
  },
  {
    id: "R-design-13",
    text: "対象の操作が在ること・その種類・条件（when）を持たないこと・誰でも行えることだけを求める要件は structural にし、action-kind・action-unconditioned・write-anonymous のうち要るものを checks に挙げる。",
    why: "操作の在ること・種類・条件の無いこと・誰でも行えることだけを求める要件を構造にする",
    since: "Issue #386",
  },
  {
    id: "R-design-14",
    text: "書き換えの結果（set のあとの値）や、保存したあとの状態を求める要件は、この形で structural にしない。",
    why: "書き換えの結果や保存後の状態を構造で確かめさせない（決定⑦と整合）",
    since: "Issue #386",
  },
  {
    id: "R-design-15",
    text: "権限（permissions）と本人確認（minIdentity）は、write-anonymous で確かめる。",
    why: "権限と本人確認を write-anonymous で確かめさせる",
    since: "Issue #393",
  },
  {
    id: "R-design-16",
    text: "出どころが答えの要件は、その問いが対象にした要件の範囲にだけ当てる。要件に無い操作・項目・画面・計算を役割 ID の表に足さない。",
    why: "答え由来の要件を、問いの対象の範囲にだけ当てさせる",
    since: "Issue #394",
  },
  {
    id: "R-design-17",
    text: "要件の一覧の「参考の文脈」は、その答えが何についての答えかを知るためだけに使う。参考の文脈に残る、選ばれなかった案・疑問・過去の要求を新しい要件にしない。食い違うときは確定した要件の文と有効な parts を優先する。",
    why: "参考の文脈を、答えの対象を知るためだけに使わせる",
    since: "Issue #394",
  },
];

/** ② に足す規則（共通の規則は buildStructuredRequest が先頭に付ける。定義の `text` から組む） */
export const DESIGN_RULES: readonly string[] = ruleTexts(DESIGN_RULE_DEFINITIONS);

/** ② の JSON Schema（構造化出力。strict の規則に合わせる） */
export const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["roles", "designs"],
  properties: {
    roles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["roleId", "kind", "entity", "name", "shared", "aliasOf", "options", "groupBy"],
        properties: {
          roleId: { type: "string", description: "役割 ID（entity の文脈を含む。例 member.name）" },
          kind: { type: "string", enum: [...TEST_TARGET_KINDS] },
          entity: { type: ["string", "null"], description: "所属の entity の役割 ID（entity 自身は null）" },
          name: { type: "string", description: "対象の名前（役割 ID の中の呼び名）" },
          shared: { type: "boolean", description: "共有を明示したか（複数の要件が同じ entity を使う）" },
          aliasOf: { type: ["string", "null"], description: "別名なら元の役割 ID（別名でなければ null）" },
          options: {
            type: ["array", "null"],
            description: "選択肢（enum）の項目なら、宣言で使う順の重複の無いキーの並び。それ以外は null",
            items: { type: "string" },
          },
          groupBy: {
            type: ["string", "null"],
            description: "見出しごとの集計（computation）なら、分ける元の選択肢の項目の役割 ID。それ以外は null",
          },
        },
      },
    },
    designs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "nature", "verification", "checks", "vocabulary", "placement", "unwritable", "notes", "ownership"],
        properties: {
          requirementId: { type: "string" },
          nature: { type: "string", enum: [...REQUIREMENT_NATURES] },
          verification: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "reason"],
            properties: {
              kind: { type: "string", enum: [...REQUIREMENT_VERIFICATION_KINDS] },
              reason: {
                type: ["string", "null"],
                description: "試験を作らないときの理由（fixed-test のときは null）",
              },
            },
          },
          checks: {
            type: "array",
            items: { type: "string", enum: [...STRUCTURAL_ASSERTIONS] },
            description: "構造で確かめる条件（field-type など）。構造で確かめない要件では空にする",
          },
          vocabulary: { type: "array", items: { type: "string" } },
          placement: { type: "array", items: { type: "string" } },
          unwritable: {
            type: "array",
            description: "書けない部分（語彙の穴。無ければ空）。書ける部分は残す",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["part", "constraintIds", "reason"],
              properties: {
                part: { type: "string", description: "書けない部分" },
                constraintIds: {
                  type: "array",
                  items: { type: "string" },
                  description: "根拠にした制約 ID（契約の規則の ID（例 R-TYPE-01）か、語彙の意味の見出しの文（例 number））",
                },
                reason: { type: "string", description: "書けない理由" },
              },
            },
          },
          notes: {
            type: "array",
            items: { type: "string" },
            description: "曖昧さ・決めたこと・不確かさ（書けないことではない。無ければ空）",
          },
          ownership: {
            type: "array",
            description: "要件が使う役割の所属（根拠つき。空でもよい）",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["roleId", "basis", "reason"],
              properties: {
                roleId: { type: "string", description: "所属させる役割 ID（役割 ID の表のもの）" },
                basis: {
                  type: "string",
                  enum: [...ROLE_OWNERSHIP_BASES],
                  description: "stated（要件の文が名指しする）／dependency（実現に必要な依存）",
                },
                reason: {
                  type: ["string", "null"],
                  description: "dependency のときの根拠（空でない文）。stated のときは null",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * 書けない部分の申告 1 件（② の `unwritable` の要素。§5・Issue #332）。**文字列から変えた**——
 * 書けない部分（`part`）だけでなく、根拠にした**制約 ID**（`constraintIds`。文書の本文から取った集合の
 * 要素）と、**理由**（`reason`）を必須にする。申告の仕分けと裏付け（`unwritable-triage.ts`）は、この
 * 3 つを使って道を分ける。
 */
export interface UnwritableClaim {
  /** 書けない部分 */
  readonly part: string;
  /** 根拠にした制約 ID（契約の規則の `R-…` と、語彙の意味の `### ` 見出し） */
  readonly constraintIds: readonly string[];
  /** 書けない理由 */
  readonly reason: string;
}

/**
 * 要件ごとの設計の 1 行（② の出力。`pipeline.ts` の `RequirementDesign` に、Issue #332 の欄を足したもの）。
 *
 * - `unwritable`（親の型）は、**書けない部分の文だけ**を持つ（互換と表示のため）。新形式の申告は
 *   `unwritableClaims` に入る。旧形式の記録は `unwritable` に文が入り、`unwritableClaims` は空になる。
 * - `notes` は、**書けないことではない**もの（曖昧さ・決めたこと・不確かさ）である。申告の仕分けで
 *   「曖昧さ」と分かったものもここへ移す。
 */
export interface RequirementDesignEntry extends RequirementDesign {
  /** 新形式の書けない申告（旧形式の記録では空） */
  readonly unwritableClaims: readonly UnwritableClaim[];
  /** 曖昧さ・決めたこと・不確かさ（書けないことではない） */
  readonly notes: readonly string[];
}

/** ② の出力（`DesignResult` に、要件ごとの新しい欄を足したもの。Issue #332） */
export interface DesignOutput extends DesignResult {
  readonly designs: readonly RequirementDesignEntry[];
}

/** 作り直し（`redoDesign`）に渡す**固定の文脈**（Issue #418） */
export interface DesignRedoContext {
  /** 元の**全役割の表**（固定。応答の表はこれと一致しなければならない） */
  readonly roles: readonly RoleEntry[];
  /** 他の要件の採用済みの設計（対象の要件の設計は含まない） */
  readonly adopted: readonly RequirementDesign[];
  /** 全体の要件の一覧（1 件を全体へ差し替えた候補を、これに照らす） */
  readonly wholeList: RequirementList;
}

/** ② が受け取るもの */
export interface DesignInput {
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /**
   * 設計の契約の版（決定 ⑨・Issue #418）。`legacy` を明示したときだけ、過去の記録の読み込みとして
   * 旧形式を通す。省けば**新契約**。
   */
  readonly version?: DesignContractVersion;
  /**
   * 作り直しの**固定の文脈**（Issue #418）。渡されたときは、表を固定し、応答 1 件を全体へ差し替えて
   * 点検する（全役割の所属・共有の点検）。省けば通常の設計。
   */
  readonly redo?: DesignRedoContext;
}

/** 選択肢（enum）のキーの並びの形を確かめる（null か、空でない重複の無い文字列の並び。Issue #418） */
function checkOptions(value: unknown, field: string, problems: Problem[]): readonly string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    problems.push({ field, message: "選択肢は文字列の並びか null であること" });
    return undefined;
  }
  const seen = new Set<string>();
  const options: string[] = [];
  let good = true;
  value.forEach((item, index) => {
    if (typeof item !== "string" || item === "") {
      problems.push({ field: `${field}[${index}]`, message: "選択肢のキーは空でない文字列であること" });
      good = false;
      return;
    }
    if (seen.has(item)) {
      problems.push({ field: `${field}[${index}]`, message: "選択肢のキーが重なっている" });
      good = false;
      return;
    }
    seen.add(item);
    options.push(item);
  });
  if (options.length === 0) {
    problems.push({ field, message: "選択肢は空でない並びであること" });
    good = false;
  }
  return good ? options : undefined;
}

/** 役割 ID の表の 1 行の形を確かめる */
function checkRoleEntry(
  value: unknown,
  field: string,
  problems: Problem[],
  requireNewFields: boolean,
): RoleEntry | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "役割 ID の表の行は写像（object）であること" });
    return undefined;
  }
  let good = true;
  const roleId = value["roleId"];
  if (typeof roleId !== "string" || roleId === "") {
    problems.push({ field: `${field}.roleId`, message: "役割 ID は空でない文字列であること" });
    good = false;
  }
  const kind = value["kind"];
  const kindValid = typeof kind === "string" && (TEST_TARGET_KINDS as readonly string[]).includes(kind);
  if (!kindValid) {
    problems.push({ field: `${field}.kind`, message: `対象の種類は ${TEST_TARGET_KINDS.join("・")} のいずれかであること` });
    good = false;
  }
  const entity = value["entity"];
  if (entity !== null && (typeof entity !== "string" || entity === "")) {
    problems.push({ field: `${field}.entity`, message: "所属の entity の役割 ID は空でない文字列か null であること" });
    good = false;
  }
  const name = value["name"];
  if (typeof name !== "string" || name === "") {
    problems.push({ field: `${field}.name`, message: "対象の名前は空でない文字列であること" });
    good = false;
  }
  const shared = value["shared"];
  if (typeof shared !== "boolean") {
    problems.push({ field: `${field}.shared`, message: "共有の印は真偽（boolean）であること" });
    good = false;
  }
  const aliasOf = value["aliasOf"];
  if (aliasOf !== null && (typeof aliasOf !== "string" || aliasOf === "")) {
    problems.push({ field: `${field}.aliasOf`, message: "別名の元の役割 ID は空でない文字列か null であること" });
    good = false;
  }
  // 選択肢（enum）のキーの並び（Issue #418）。新契約では必須。欄が無い旧形式の記録は省ける。
  let options: readonly string[] | null | undefined;
  if (value["options"] === undefined) {
    if (requireNewFields) {
      problems.push({ field: `${field}.options`, message: "選択肢の欄（options）が要る（選択肢の項目でなければ null）" });
      good = false;
    }
  } else {
    options = checkOptions(value["options"], `${field}.options`, problems);
    if (options === undefined) good = false;
  }
  // 項目でない役割の options は null でなければならない（Issue #418）
  if (kindValid && kind !== "field" && options !== null && options !== undefined) {
    problems.push({ field: `${field}.options`, message: "項目でない役割の選択肢は null であること" });
    good = false;
  }
  // 見出しの元の項目（Issue #433）。新契約では必須。欄が無い旧形式の記録は省ける。
  let groupBy: string | null | undefined;
  if (value["groupBy"] === undefined) {
    if (requireNewFields) {
      problems.push({ field: `${field}.groupBy`, message: "見出しの元の項目の欄（groupBy）が要る（計算でなければ null）" });
      good = false;
    }
  } else if (value["groupBy"] === null) {
    groupBy = null;
  } else if (typeof value["groupBy"] !== "string" || value["groupBy"] === "") {
    problems.push({ field: `${field}.groupBy`, message: "見出しの元の項目は空でない文字列か null であること" });
    good = false;
  } else {
    groupBy = value["groupBy"];
  }
  // 計算でない役割の groupBy は null でなければならない（Issue #433）
  if (kindValid && kind !== "computation" && groupBy !== null && groupBy !== undefined) {
    problems.push({ field: `${field}.groupBy`, message: "計算でない役割の見出しの元の項目は null であること" });
    good = false;
  }
  if (!good) return undefined;
  return {
    roleId: roleId as string,
    kind: kind as RoleEntry["kind"],
    entity: entity as string | null,
    name: name as string,
    shared: shared as boolean,
    aliasOf: aliasOf as string | null,
    ...(options === undefined ? {} : { options }),
    ...(groupBy === undefined ? {} : { groupBy }),
  };
}

/** 所属 1 件の形を確かめる（roleId 空・basis の値・dependency の reason 欠けを断る。Issue #418） */
function checkOwnership(value: unknown, field: string, problems: Problem[]): RoleOwnership | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "所属は「役割 ID・根拠・理由」の写像であること" });
    return undefined;
  }
  let good = true;
  const roleId = value["roleId"];
  if (typeof roleId !== "string" || roleId === "") {
    problems.push({ field: `${field}.roleId`, message: "所属の役割 ID は空でない文字列であること" });
    good = false;
  }
  const basis = value["basis"];
  const basisValid = typeof basis === "string" && (ROLE_OWNERSHIP_BASES as readonly string[]).includes(basis);
  if (!basisValid) {
    problems.push({
      field: `${field}.basis`,
      message: `所属の根拠は ${ROLE_OWNERSHIP_BASES.join("・")} のいずれかであること`,
    });
    good = false;
  }
  const reason = value["reason"];
  if (basisValid && basis === "dependency") {
    if (typeof reason !== "string" || reason.trim() === "") {
      problems.push({ field: `${field}.reason`, message: "依存の所属には理由（reason）が要る（空でない文字列）" });
      good = false;
    }
  } else if (reason !== null && reason !== undefined) {
    problems.push({ field: `${field}.reason`, message: "名指し（stated）の所属の理由は null であること" });
    good = false;
  }
  if (!good) return undefined;
  return {
    roleId: roleId as string,
    basis: basis as RoleOwnership["basis"],
    reason: typeof reason === "string" ? reason : null,
  };
}

/** 確かめ方の形を確かめる（fixed-test 以外は理由が要る） */
function checkVerification(value: unknown, field: string, problems: Problem[]): RequirementVerification | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "確かめ方は写像（object）であること" });
    return undefined;
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !(REQUIREMENT_VERIFICATION_KINDS as readonly string[]).includes(kind)) {
    problems.push({ field: `${field}.kind`, message: `確かめ方は ${REQUIREMENT_VERIFICATION_KINDS.join("・")} のいずれかであること` });
    return undefined;
  }
  if (kind === "fixed-test") return { kind: "fixed-test" };
  const reason = value["reason"];
  if (typeof reason !== "string" || reason === "") {
    problems.push({ field: `${field}.reason`, message: `確かめ方 ${kind} には理由（reason）が要る（空でない文字列）` });
    return undefined;
  }
  return { kind: kind as "structural" | "unresolved", reason };
}

/** 書けない部分の申告 1 件の形を確かめる（Issue #332） */
function checkUnwritableClaim(value: unknown, field: string, problems: Problem[]): UnwritableClaim | undefined {
  if (!isRecord(value)) {
    problems.push({
      field,
      message: "書けない部分は「部分（part）・制約 ID（constraintIds）・理由（reason）」の写像であること",
    });
    return undefined;
  }
  let good = true;
  const part = value["part"];
  if (typeof part !== "string" || part === "") {
    problems.push({ field: `${field}.part`, message: "書けない部分は空でない文字列であること" });
    good = false;
  }
  const reason = value["reason"];
  if (typeof reason !== "string" || reason === "") {
    problems.push({ field: `${field}.reason`, message: "書けない理由は空でない文字列であること" });
    good = false;
  }
  const constraintIds = checkStringArray(value["constraintIds"], `${field}.constraintIds`, problems);
  if (constraintIds === undefined) good = false;
  if (!good || constraintIds === undefined) return undefined;
  return { part: part as string, constraintIds, reason: reason as string };
}

/**
 * 求める構造の検査の中身（`checks`）の形を確かめる（Issue #386）。選択肢の内側で、重ならないこと。
 * 合わなければ断る（`undefined`）。旧形式の記録は `checks` の欄を省くので、ここへは来ない。
 */
function checkChecks(
  value: unknown,
  field: string,
  problems: Problem[],
): readonly StructuralAssertionKind[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ field, message: "checks は並び（array）であること" });
    return undefined;
  }
  const seen = new Set<string>();
  const checks: StructuralAssertionKind[] = [];
  let good = true;
  value.forEach((item, index) => {
    if (!isStructuralAssertionKind(item)) {
      problems.push({
        field: `${field}[${index}]`,
        message: `checks の中身は ${STRUCTURAL_ASSERTIONS.join("・")} のいずれかであること`,
      });
      good = false;
      return;
    }
    if (seen.has(item)) {
      problems.push({ field: `${field}[${index}]`, message: `checks の中身 ${item} が重なっている` });
      good = false;
      return;
    }
    seen.add(item);
    checks.push(item);
  });
  return good ? checks : undefined;
}

function checkDesign(
  value: unknown,
  field: string,
  problems: Problem[],
  planned: boolean,
): RequirementDesignEntry | undefined {
  if (!isRecord(value)) {
    problems.push({ field, message: "設計は写像（object）であること" });
    return undefined;
  }
  const requirementId = value["requirementId"];
  const validId = typeof requirementId === "string" && requirementId !== "";
  if (!validId) {
    problems.push({ field: `${field}.requirementId`, message: "要件 ID は空でない文字列であること" });
  }
  const natureRaw = value["nature"];
  let nature: RequirementDesign["nature"];
  if (natureRaw !== undefined) {
    if (!isRequirementNature(natureRaw)) {
      problems.push({ field: `${field}.nature`, message: `種類は ${REQUIREMENT_NATURES.join("・")} のいずれかであること` });
    } else {
      nature = natureRaw;
    }
  }
  const verificationRaw = value["verification"];
  const verification =
    verificationRaw === undefined ? undefined : checkVerification(verificationRaw, `${field}.verification`, problems);
  // checks（求める構造の検査の中身。Issue #386）。欄が無い旧形式の記録は省ける（後方互換）。
  const checksRaw = value["checks"];
  let checks: readonly StructuralAssertionKind[] | undefined;
  let checksOk = true;
  if (checksRaw !== undefined) {
    const parsed = checkChecks(checksRaw, `${field}.checks`, problems);
    if (parsed === undefined) checksOk = false;
    else checks = parsed;
  }
  // 構造で確かめるのに、確かめる条件を 1 つも挙げていなければ断る（挙げられないなら structural にしない）
  if (checksOk && checks !== undefined && verification?.kind === "structural" && checks.length === 0) {
    problems.push({
      field: `${field}.checks`,
      message: "構造で確かめる要件の checks は空でない（確かめる条件を挙げる）",
    });
    checksOk = false;
  }
  const vocabulary = checkStringArray(value["vocabulary"], `${field}.vocabulary`, problems);
  const placement = checkStringArray(value["placement"], `${field}.placement`, problems);

  // 新形式（unwritable の要素が写像、または notes がある）か、旧形式（unwritable が文字列の並び）か。
  // 旧形式は後方互換で通す（記録の再生を壊さない）。新形式は 3 つの欄を必須にする。
  const unwritableRaw = value["unwritable"];
  const notesRaw = value["notes"];
  const newFormat =
    notesRaw !== undefined || (Array.isArray(unwritableRaw) && unwritableRaw.some((item) => isRecord(item)));
  let unwritable: readonly string[] | undefined;
  let unwritableClaims: readonly UnwritableClaim[] = [];
  let notes: readonly string[] = [];
  if (newFormat) {
    if (Array.isArray(unwritableRaw)) {
      const claims: UnwritableClaim[] = [];
      let good = true;
      unwritableRaw.forEach((item, index) => {
        const claim = checkUnwritableClaim(item, `${field}.unwritable[${index}]`, problems);
        if (claim === undefined) good = false;
        else claims.push(claim);
      });
      if (good) {
        unwritableClaims = claims;
        unwritable = claims.map((claim) => claim.part);
      }
    } else {
      problems.push({ field: `${field}.unwritable`, message: "書けない部分の並び（array）であること" });
    }
    if (notesRaw !== undefined) {
      const parsed = checkStringArray(notesRaw, `${field}.notes`, problems);
      if (parsed !== undefined) notes = parsed;
    }
  } else {
    unwritable = checkStringArray(unwritableRaw, `${field}.unwritable`, problems);
  }

  // 所属（ownership。Issue #418）。新契約では必須。欄が無い旧形式の記録は省ける（混在は応答の側で断る）。
  const ownershipRaw = value["ownership"];
  let ownership: readonly RoleOwnership[] | undefined;
  let ownershipOk = true;
  if (ownershipRaw === undefined) {
    if (planned) {
      problems.push({ field: `${field}.ownership`, message: "役割の所属（ownership）の欄が要る" });
      ownershipOk = false;
    }
  } else if (!Array.isArray(ownershipRaw)) {
    problems.push({ field: `${field}.ownership`, message: "所属は並び（array）であること" });
    ownershipOk = false;
  } else {
    const list: RoleOwnership[] = [];
    let good = true;
    ownershipRaw.forEach((item, index) => {
      const parsed = checkOwnership(item, `${field}.ownership[${index}]`, problems);
      if (parsed === undefined) good = false;
      else list.push(parsed);
    });
    if (good) ownership = list;
    else ownershipOk = false;
  }

  if (
    !validId ||
    !checksOk ||
    !ownershipOk ||
    vocabulary === undefined ||
    placement === undefined ||
    unwritable === undefined ||
    (verificationRaw !== undefined && verification === undefined)
  ) {
    return undefined;
  }
  return {
    requirementId: requirementId as string,
    ...(nature === undefined ? {} : { nature }),
    ...(verification === undefined ? {} : { verification }),
    ...(checks === undefined ? {} : { checks }),
    vocabulary,
    placement,
    unwritable,
    unwritableClaims,
    notes,
    ...(ownership === undefined ? {} : { ownership }),
  };
}

/**
 * ② の応答の形を確かめる。**新契約**（`version` を省いたとき）では、役割 ID の表・所属・`options` の
 * 必須の欄と、所属・選択肢の有無の混在を断る。`legacy` を明示したときだけ、役割の表・所属・`options` の
 * 無い旧形式の記録を通す（決定 ⑨・Issue #418）。
 */
export function checkDesignOutput(output: unknown, version?: DesignContractVersion): ShapeCheck<DesignOutput> {
  if (!isRecord(output)) {
    return { ok: false, problems: [{ field: "", message: "応答は写像（object）であること" }] };
  }
  const raw = output["designs"];
  if (!Array.isArray(raw)) {
    return { ok: false, problems: [{ field: "designs", message: "設計の並び（array）であること" }] };
  }
  const planned = version !== LEGACY_DESIGN_CONTRACT;
  const problems: Problem[] = [];
  const designs: RequirementDesignEntry[] = [];
  let designsWithOwnership = 0;
  raw.forEach((item, index) => {
    if (isRecord(item) && item["ownership"] !== undefined) designsWithOwnership += 1;
    const checked = checkDesign(item, `designs[${index}]`, problems, planned);
    if (checked !== undefined) designs.push(checked);
  });
  let roles: readonly RoleEntry[] | undefined;
  const rawRoles = output["roles"];
  let rolesWithOptions = 0;
  let rolesWithGroupBy = 0;
  if (rawRoles === undefined) {
    if (planned) problems.push({ field: "roles", message: "役割 ID の表（roles）が要る" });
  } else if (!Array.isArray(rawRoles)) {
    problems.push({ field: "roles", message: "役割 ID の表は並び（array）であること" });
  } else {
    const entries: RoleEntry[] = [];
    let good = true;
    rawRoles.forEach((item, index) => {
      if (isRecord(item) && item["options"] !== undefined) rolesWithOptions += 1;
      if (isRecord(item) && item["groupBy"] !== undefined) rolesWithGroupBy += 1;
      const checked = checkRoleEntry(item, `roles[${index}]`, problems, planned);
      if (checked === undefined) good = false;
      else entries.push(checked);
    });
    if (good) roles = entries;
  }
  // 混在（一部の設計にだけ所属がある・一部の行にだけ options がある・一部の行にだけ groupBy がある）は、
  // 互換でも断る（決定 ⑨）
  if (designsWithOwnership > 0 && designsWithOwnership < raw.length) {
    problems.push({ field: "designs", message: "所属（ownership）の有無が設計ごとに混ざっている" });
  }
  if (rawRoles !== undefined && Array.isArray(rawRoles) && rolesWithOptions > 0 && rolesWithOptions < rawRoles.length) {
    problems.push({ field: "roles", message: "選択肢（options）の有無が役割ごとに混ざっている" });
  }
  if (rawRoles !== undefined && Array.isArray(rawRoles) && rolesWithGroupBy > 0 && rolesWithGroupBy < rawRoles.length) {
    problems.push({ field: "roles", message: "見出しの元の項目（groupBy）の有無が役割ごとに混ざっている" });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { ...(roles === undefined ? {} : { roles }), designs } };
}

/** 新しい欄（役割 ID の表・種類・確かめ方）を持つ設計か（中身の点検を掛けるかの判定） */
export function isPlannedDesign(design: DesignResult): boolean {
  if (design.roles !== undefined) return true;
  return design.designs.some((entry) => entry.nature !== undefined || entry.verification !== undefined);
}

/**
 * 役割 ID の表の、同名の対象についての規則（§1・②・Issue #307）。**Problem の `field` は位置（配列の
 * 添字）、`message` は分類ごとの固定文**（役割 ID・名前・entity の値を埋めない。§1・②・Issue #445）。
 */
function checkRoleTable(roles: readonly RoleEntry[]): readonly Problem[] {
  const problems: Problem[] = [];
  // 同じ役割 ID は 1 つに決まること（同じ役割 ID を別の名前・別の entity に使い回さない）
  const firstById = new Map<string, RoleEntry>();
  roles.forEach((entry, index) => {
    const previous = firstById.get(entry.roleId);
    if (previous === undefined) {
      firstById.set(entry.roleId, entry);
      return;
    }
    if (previous.name !== entry.name || previous.entity !== entry.entity) {
      problems.push({
        field: `roles[${index}]`,
        message: "役割 ID を、別の対象（名前・所属）に使い回している（1 つの役割 ID は 1 つの対象にだけ使う）",
      });
    }
  });
  for (let i = 0; i < roles.length; i += 1) {
    for (let j = i + 1; j < roles.length; j += 1) {
      const a = roles[i];
      const b = roles[j];
      if (a === undefined || b === undefined || a.name !== b.name) continue;
      if (a.entity !== b.entity) {
        // 同名の別 entity を同じ役割 ID にした（潰した）
        if (a.roleId === b.roleId) {
          problems.push({
            field: `roles[${j}]`,
            message: "同名の別 entity を同じ役割 ID にしている",
          });
        }
        continue;
      }
      if (a.roleId !== b.roleId) {
        // 同じ名前の対象が、共有も別名も明示せずに複数の役割 ID になっている
        const declared = a.shared || b.shared || a.aliasOf !== null || b.aliasOf !== null;
        if (!declared) {
          problems.push({
            field: `roles[${j}]`,
            message: "同じ名前の対象が、共有も別名も明示せずに 2 つの役割 ID になっている",
          });
        }
      }
    }
  }
  return problems;
}

/**
 * 見出しの元の項目（`groupBy`）の中身を確かめる（**新契約**。Issue #433）。合わない欄を**すべて**返す。
 *
 *   - `groupBy` の先の役割 ID が、役割 ID の表に無い
 *   - `groupBy` の先の役割が項目（`kind` が `field`）でない
 *   - `groupBy` の先の項目に選択肢（`options`）が無い（`null`）
 *
 * **Problem の `field`・`message` に、役割 ID の値を埋めない**（位置は配列の添字で示す）。
 */
export function checkGroupBy(roles: readonly RoleEntry[]): readonly Problem[] {
  const problems: Problem[] = [];
  const roleById = new Map<string, RoleEntry>();
  for (const role of roles) if (!roleById.has(role.roleId)) roleById.set(role.roleId, role);
  roles.forEach((role, index) => {
    if (role.kind !== "computation" || role.groupBy === null || role.groupBy === undefined) return;
    const field = `roles[${index}].groupBy`;
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
  return problems;
}

/**
 * 役割の所属の中身を確かめる（**新契約**。§1・②・Issue #418）。合わない欄を**すべて**返す。
 *
 *   - 所属の役割 ID が表に無い／同じ要件の中で重なる
 *   - 表の役割がどの要件にも所属しない（根拠の無い役割＝未達）
 *   - entity を参照する役割（`entity` が null でない）を所属させた要件に、参照先の entity の所属が無い
 *   - 2 つ以上の要件に所属する役割が `shared` を真にしていない
 *   - `aliasOf` の先が表に無い・別名の別名
 *
 * **Problem の `field`・`message` に、役割 ID・要件 ID の値を埋めない**（停止の要約と段の失敗の記録に
 * 写るため。位置は配列の添字で示す）。
 */
export function checkDesignOwnership(design: DesignResult): readonly Problem[] {
  const problems: Problem[] = [];
  const roles = design.roles ?? [];
  const roleById = new Map<string, RoleEntry>();
  const roleIndexById = new Map<string, number>();
  roles.forEach((entry, index) => {
    if (!roleById.has(entry.roleId)) {
      roleById.set(entry.roleId, entry);
      roleIndexById.set(entry.roleId, index);
    }
  });

  // aliasOf の先が表に無い・別名の別名
  roles.forEach((entry, index) => {
    if (entry.aliasOf === null) return;
    const target = roleById.get(entry.aliasOf);
    if (target === undefined) {
      problems.push({ field: `roles[${index}].aliasOf`, message: "別名の元の役割 ID が役割 ID の表に無い" });
      return;
    }
    if (target.aliasOf !== null) {
      problems.push({ field: `roles[${index}].aliasOf`, message: "別名の別名は作らない（元の役割 ID を指す）" });
    }
  });

  // 要件ごとの所属（重なりと、表に無い ID）
  const ownersOf = new Map<string, string[]>();
  design.designs.forEach((entry, dIndex) => {
    const seen = new Set<string>();
    (entry.ownership ?? []).forEach((ownership, oIndex) => {
      const field = `designs[${dIndex}].ownership[${oIndex}].roleId`;
      if (!roleById.has(ownership.roleId)) {
        problems.push({ field, message: "所属の役割 ID が役割 ID の表に無い" });
        return;
      }
      if (seen.has(ownership.roleId)) {
        problems.push({ field, message: "同じ要件の中で役割の所属が重なっている" });
        return;
      }
      seen.add(ownership.roleId);
      const owners = ownersOf.get(ownership.roleId);
      if (owners === undefined) ownersOf.set(ownership.roleId, [entry.requirementId]);
      else if (!owners.includes(entry.requirementId)) owners.push(entry.requirementId);
    });
  });

  // どの要件にも所属しない役割（根拠の無い役割＝未達）
  roles.forEach((entry, index) => {
    if (!ownersOf.has(entry.roleId)) {
      problems.push({
        field: `roles[${index}]`,
        message: "どの要件にも所属しない役割が表に残っている（根拠の無い役割）",
      });
    }
  });

  // 参照先の entity の所属を伴わない役割の所属
  design.designs.forEach((entry, dIndex) => {
    const owned = new Set((entry.ownership ?? []).map((ownership) => ownership.roleId));
    (entry.ownership ?? []).forEach((ownership, oIndex) => {
      const role = roleById.get(ownership.roleId);
      if (role === undefined || role.entity === null) return;
      const entityRole = roleById.get(role.entity);
      if (entityRole === undefined || entityRole.kind !== "entity") return;
      if (!owned.has(role.entity)) {
        problems.push({
          field: `designs[${dIndex}].ownership[${oIndex}].roleId`,
          message: "参照先の entity の所属を伴わない役割を所属させている",
        });
      }
    });
  });

  // 2 つ以上の要件に所属する役割が shared を真にしていない
  for (const [roleId, owners] of ownersOf) {
    if (owners.length < 2) continue;
    const role = roleById.get(roleId);
    if (role !== undefined && role.shared !== true) {
      const index = roleIndexById.get(roleId) ?? 0;
      problems.push({ field: `roles[${index}]`, message: "2 つ以上の要件に所属する役割は shared を真にすること" });
    }
  }

  return problems;
}

/**
 * 設計の中身を、要件の一覧に照らして確かめる（§1・②・Issue #307）。合わない欄を**すべて**挙げて返す。
 *
 *   - 役割 ID の表がある（空でない）
 *   - 一覧の要件 ID ごとに、設計が 1 つあり、種類（nature）と確かめ方（verification）がある
 *   - fixed-test 以外の確かめ方には理由がある
 *   - 同名の対象の規則（共有・別名の明示、同名の別 entity を潰さない）
 *
 * **新契約**（`version` を省いたとき）では、上の規則に**所属の点検**（`checkDesignOwnership`）を足す。
 * `legacy` を明示したときは、従来どおり所属を求めない（決定 ⑨・Issue #418）。
 *
 * **Problem の `field` は位置、`message` は分類ごとの固定文**（要件 ID の値を埋めない。要件ごとの問題は
 * `requirements[添字]`、応答の設計ごとの問題は `designs[添字]` で位置を示す。§1・②・Issue #445）。
 */
export function checkDesignPlan(
  list: RequirementList,
  design: DesignResult,
  version?: DesignContractVersion,
): readonly Problem[] {
  const problems: Problem[] = [];
  const roles = design.roles;
  if (roles === undefined || roles.length === 0) {
    problems.push({ field: "roles", message: "役割 ID の表は空でない並びであること" });
  } else {
    problems.push(...checkRoleTable(roles));
  }

  const byId = new Map<string, RequirementDesign>();
  design.designs.forEach((entry, index) => {
    if (byId.has(entry.requirementId)) {
      problems.push({ field: `designs[${index}]`, message: "同じ要件 ID の設計が重なっている" });
    }
    byId.set(entry.requirementId, entry);
  });
  const idSet = new Set(list.requirements.map((requirement) => requirement.id));
  design.designs.forEach((entry, index) => {
    if (!idSet.has(entry.requirementId)) {
      problems.push({ field: `designs[${index}]`, message: "一覧に無い要件 ID である" });
    }
  });
  list.requirements.forEach((requirement, requirementIndex) => {
    const entry = byId.get(requirement.id);
    if (entry === undefined) {
      problems.push({ field: `requirements[${requirementIndex}]`, message: "要件の設計が無い" });
      return;
    }
    if (entry.nature === undefined) {
      problems.push({
        field: `requirements[${requirementIndex}]`,
        message: "要件に種類（決まりを含む／在ることだけ）が無い",
      });
    }
    if (entry.verification === undefined) {
      problems.push({ field: `requirements[${requirementIndex}]`, message: "要件に確かめ方が無い" });
    }
  });
  if (version !== LEGACY_DESIGN_CONTRACT) {
    problems.push(...checkGroupBy(roles ?? []));
    problems.push(...checkDesignOwnership(design));
  }
  return problems;
}

/**
 * 書けない部分の申告が、**渡した文書の本文の制約 ID に裏付けられている**かを確かめる（§1・②・Issue #332）。
 *
 * 制約 ID は、段に渡した文書の本文から取り出した集合（契約の規則の `R-…` の ID と、語彙の意味の
 * `### ` 見出し）に入っていなければならない。**制約 ID の無い申告**と、**文書に無い ID を使った申告**を、
 * 欄つきで断る。旧形式の記録（文字列の `unwritable`）は申告（`unwritableClaims`）を持たないので、
 * ここでは何も断らない。
 *
 * **`field` に要件 ID の値を埋めない**（位置は設計の添字と固定の欄名で示す。§1・②・Issue #445）。
 */
export function checkDesignConstraints(design: DesignOutput, documents: readonly PromptDocument[]): readonly Problem[] {
  const known = constraintIdsIn(documents);
  const problems: Problem[] = [];
  design.designs.forEach((entry, designIndex) => {
    entry.unwritableClaims.forEach((claim, index) => {
      const field = `designs[${designIndex}].unwritable[${index}].constraintIds`;
      if (claim.constraintIds.length === 0) {
        problems.push({
          field,
          message: "書けない部分には、根拠にした制約 ID が要る（文書の規則の ID か見出しの文）",
        });
        return;
      }
      for (const raw of claim.constraintIds) {
        // **生の申告の ID を 1 回だけ**正規化して、文書から取り出した集合（正規化済み）と突き合わせる
        // （Issue #398）。`### ### action` は 1 回だけ外すので `### action` のまま残り、断られる。
        const id = normalizeConstraintId(raw);
        if (id === "" || !known.has(id)) {
          problems.push({ field, message: "文書に無い制約 ID である" });
        }
      }
    });
  });
  return problems;
}

/**
 * 書けない申告の制約 ID を**正規化した写し**を作る（保存する側。Issue #398）。段は、根拠の照合
 * （`checkDesignConstraints`）を通ったあとにこれを返す——下流（仕分け・Plan の根拠）へ渡る ID は
 * 正規化後になる。確定済みの Plan を読み込むときは書き換えない（読み込みの側では正規化しない）。
 */
function normalizeDesignClaims(design: DesignOutput): DesignOutput {
  return {
    ...design,
    designs: design.designs.map((entry) => ({
      ...entry,
      unwritableClaims: entry.unwritableClaims.map((claim) => ({
        ...claim,
        constraintIds: normalizeConstraintIds(claim.constraintIds),
      })),
    })),
  };
}

/**
 * ② を回す。形は `callStructuredChecked` が 1 回だけやり直し（2 試行）、**中身の点検に合わなければ
 * 1 回だけ作り直させる**（`DESIGN_ROUNDS`）。前回の問題（欄・短い説明）はデータ
 * （`前回の作り直しの指示`）にだけ入れ、規則（instructions・rules）と文書の前置きへは昇格させない。
 *
 * **中身の枠が握るのは `unmet` だけ**——形の失敗（`malformed`）・予算・締切・呼び出しの数・拒否・
 * 要求の誤り・打ち切り・通信の失敗は、そのまま返す（中身の枠で再試行しない）。2 回目も合わなければ
 * `unmet`（`attempts` は `DESIGN_ROUNDS`、問題は最後の回のもの）にする。
 *
 * **枠の数**：形（`callStructuredChecked` の 2 試行）× 中身（`DESIGN_ROUNDS` = 2 回）＝ 1 回の呼び出しで
 * 構造化の呼び出しは最大 4 回。通信（timeout・network・5xx）のやり直しは共通の口（`CallGateway`）の
 * 試行の数（既定 2）で別に数え、段では数えない。**どの試行もジョブの総呼び出しの上限に数える。**
 */
export async function runDesign(input: DesignInput): Promise<StageOutcome<DesignOutput>> {
  const planned = input.version !== LEGACY_DESIGN_CONTRACT;
  let previous: readonly Problem[] = [];
  for (let round = 1; round <= DESIGN_ROUNDS; round += 1) {
    const data: PromptData[] = [{ name: "要件の一覧", text: serializeJson(input.list) }];
    if (input.redo !== undefined) {
      // 固定の文脈（元の全役割の表と、他の要件の採用済みの設計）をデータで渡す（Issue #418）
      data.push({ name: "固定の役割 ID の表", text: serializeJson(input.redo.roles) });
      data.push({ name: "他の要件の設計", text: serializeJson(input.redo.adopted) });
    }
    if (previous.length > 0) {
      data.push({ name: "前回の作り直しの指示", text: serializeJson(previous) });
    }
    const request = buildStructuredRequest({
      rules: input.redo === undefined ? DESIGN_RULES : [...DESIGN_RULES, REDO_DESIGN_FIXED_TABLE_RULE],
      documents: input.documents,
      data,
      schemaName: DESIGN_SCHEMA_NAME,
      schema: DESIGN_SCHEMA,
      maxOutputTokens: input.gateway.maxOutputTokens("design"),
    });
    const answer = await callStructuredChecked(input.gateway, {
      request,
      check: (output: unknown) => checkDesignOutput(output, input.version),
    });
    if (!answer.ok) return answer;
    const problems: Problem[] = [];
    if (input.redo !== undefined) {
      // 表は固定。応答の表が元の表と一致しなければ断る（Issue #418）
      if (!sameRoles(answer.value.roles ?? [], input.redo.roles)) {
        problems.push({
          field: "roles",
          message: "固定の役割 ID の表と一致しない（行の増減・欄の違い・options の変更）",
        });
      }
      // 応答 1 件を全体へ差し替えた候補に対して、全役割の所属・共有を点検する（Issue #418）
      const candidate: DesignResult = {
        roles: input.redo.roles,
        designs: [...input.redo.adopted, ...answer.value.designs],
      };
      problems.push(...checkDesignPlan(input.redo.wholeList, candidate));
    } else if (planned) {
      // 新契約では、中身の点検（所属を含む）を必ず掛ける（決定 ⑨・Issue #418）
      problems.push(...checkDesignPlan(input.list, answer.value));
    } else if (isPlannedDesign(answer.value)) {
      // 旧形式の記録（試験の fixture）は、新しい欄を持つときだけ中身の点検を掛ける（後方互換）
      problems.push(...checkDesignPlan(input.list, answer.value, LEGACY_DESIGN_CONTRACT));
    }
    // 書けない部分の根拠（制約 ID）は、旧形式では申告が無いので何も断らない（#332）
    problems.push(...checkDesignConstraints(answer.value, input.documents));
    if (problems.length === 0) {
      // 根拠の照合を通ったあと、保存する側の ID を正規化する（Issue #398）
      const normalized = normalizeDesignClaims(answer.value);
      if (input.redo !== undefined) return { ok: true, value: { ...normalized, roles: input.redo.roles } };
      return { ok: true, value: normalized };
    }
    previous = problems;
    // 中身の点検に落ちたので作り直す。この**中身のやり直し**を、共通の口へ告げる（Issue #446）。
    if (round < DESIGN_ROUNDS) input.gateway.noteRetry("content");
  }
  return { ok: false, failure: { kind: "unmet", attempts: DESIGN_ROUNDS, problems: previous } };
}

/** 2 つの役割 ID の表が、行・欄・options まで一致するか（作り直しの「表は固定」の点検。Issue #418） */
function sameRoles(a: readonly RoleEntry[], b: readonly RoleEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((role, index) => roleKey(role) === roleKey(b[index]!));
}

/** 役割 1 行の、値の比較のための鍵（options の無い旧形式と null を同じに扱う） */
function roleKey(role: RoleEntry): string {
  return JSON.stringify([
    role.roleId,
    role.kind,
    role.entity,
    role.name,
    role.shared,
    role.aliasOf,
    role.options ?? null,
    role.groupBy ?? null,
  ]);
}
