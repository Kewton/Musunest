// C2 要件の写像（08-architecture-v1.2.md §4 の C2・C2'・§6・§9 の手 3a・3b。Issue #593・#594・#627）。
//
// 旗 `v12.ids` が on の走りだけ、T1 の要件ごとの部分（所属・確かめ方・分類）を **1 回の呼び出し**で書かせる。応答は要件ごとに
// `{requirementId, roles, verification, nature}` で、**要件 ID と行の ID を書かせ、コードが照らす**（方法論 03 の H2。写し・
// 出典・引用は無い。08 §6）。手 3b（#594）は要件 5 件ごとの束に分けたが、束が表全体の規則（どの要件にも所属しない行を残さない）
// を各束で満たそうとして全行を抱え込み、所属が膨らんで時間も束の数だけ足し算になったので、束だけを戻した（08 §9 の手 3 の戻す
// 条件。Issue #627）。
//
//   - データ：確定した仕様（要件の種類を外す）・要件の一覧（要件 ID・文・引用）・C1 の行（**名前は見せない**）・文書の名前と制約 ID
//   - C2'（`inspectMapping`）：構造の検査の対象（`checkCheckTargets`）・要件ごとにちょうど 1 件（欠落・重複・一覧に無い ID）・
//     所属の ID が行にある・今の T1' の (e)(g)。落ちれば共通の窓口の形のやり直しで 1 回（前回の応答と問題をデータで）。2 回続けば
//     `unmet`
//   - 初回の形のやり直し（Issue #660。方法論 03 の H3・H4）：初回の問題が**全部要件へ帰属できる**なら、落ちた要件だけを書き直させ
//     （前回の写像・書き直す要件・その問題をデータで足し、部分専用の規則で 1 回だけ呼ぶ。形の再試行として共通の口へ告げる）、
//     応答の要件 ID の集合が書き直す要件と厳密に一致すれば前回の応答の残りの要件（バイト列で同じ）と一覧の順に合併して、C2' を
//     **全部**掛ける。帰属できない問題（孤立行・要件 ID の重複・一覧に無い要件 ID・骨組み）が 1 つでもあれば、今までどおり共通の
//     窓口の形のやり直し（全体の作り直し）。部分に課すのは固定の入力とその部分の出力だけで真偽が決まる条件だけで、孤立行・網羅・
//     重複は合併後にコードが見る（#627 の教訓）
//   - C3 の拒否のあとの 2 回目（呼ぶ側が `previous` を渡す。Issue #661。方法論 03 の H3・H4）：書き直す要件は C3 が拒否した要件
//     ID の集合（拒否の種類に依らず全部。一覧の順）。前回の写像・拒否・印に書き直す要件を足したデータと部分専用の規則で**1 回だけ**
//     呼び、応答の要件 ID の集合が書き直す要件と厳密に一致すれば前回の写像の残りの要件（バイト列で同じ）と一覧の順に合併して、C2'
//     を**全部**掛ける。どこかで落ちても形の再試行は無い（08 §4.1）——`unmet`（`attempts` 1）を返し、呼ぶ側は初回の表と初回の
//     拒否の組のまま持ち越す
//
// 構造の検査の対象の欄（Issue #594。方法論 03 の F4・H1・H2）：コードが対象の実在・種類・view-shows の対を照らし、対象の行を所属に
// 足す（basis dependency・reason に検査の種類）。
//
// 検査の種類ごとの欄（Issue #682。方法論 03 の H3）：表の契約は「checks は検査の種類の集合」（表の検査が種類の重なりを断る）だが、
// 並びの schema は重なりを許し、初回の形の落ちの多くが重なりだった。`verification.checks` を検査の種類ごとの欄（全部 required）を
// 持つ写像（structural 以外は null）にする。復号は欄を種類の固定の順（`STRUCTURAL_ASSERTIONS`）で `[{check, targetId, sourceId}]` に
// 写してから、今の照合と表の検査（重なり・checks 無し・孤立行・制約 ID）を全部そのまま掛ける。
//
// 対象の並び（Issue #724。方法論 03 の H2）：1 種類 1 対象では、同じ種類の検査を 2 つ以上の行に掛けて確かめる要件を書けず、
// fixed-test に寄せると試験 0 本・操作が未検証になる要件があった。各欄を null か対象の写像の並び（1 件以上。view-shows の要素だけ
// `{targetId, sourceId}`）にし、復号は種類の固定の順・種類の中は応答の順に写す（`checks` は `targets` と同じ順・同じ数で、同じ種類が
// 複数回並んでよい）。空の並びは形の固定文で断る（schema の minItems に頼らない）。表の検査の重なりは「同じ組が 2 回」の意味になる
// （`checkMappedTable`。組は種類＋targetId、view-shows は種類＋targetId＋sourceId）。
//
// 整える手（Issue #723。方法論 03 の H1・04 §1）：応答から組んで検査の対象の行を所属に足し、一覧の順に並べた表に、C2' の**前**に
// コードの決まった手順を手 1 → 手 2 の順で 1 回だけ当てる（`normalizeMappedTable`。初回・落ちた要件だけの書き直しの合併・C3 の
// 拒否のあとの 2 回目の合併の全部が `inspectMappingSourced` を通るので同じ関数が当たる）。手は表の行（kind・type・refEntity・
// hasWhen）と basis だけで決まり、規則の文と LLM の要求は変えない。C2' は整えた表に今のまま掛け、表の SHA も整えた表で取る。
// 前回の写像（C2 の 2 回目の要求のデータ）は整える前の raw のまま（整えた差分を LLM に見せない）。整えた中身は結果の `normalized`
// で返し、診断の table-rounds にだけ残す。
//
// 参照の照合の数（`ReferenceCounts`）：照らした参照＝応答の要件 ID・所属の ID・検査の対象の ID の全部、知らない ID＝一覧に無い
// 要件 ID・行に無い所属や対象の ID、重複＝同じ要件 2 件・同じ要件の中の同じ行、別の束の ID＝要件 ID の欄に行の ID の形・所属や
// 対象の欄に一覧の要件 ID。
import type { ConfirmedPlan } from "@musunest/appspec-schema";
import type { CallGateway } from "../../call.js";
import { REQUIREMENT_NATURES, STRUCTURAL_ASSERTIONS } from "../../fixed-test.js";
import { ROLE_OWNERSHIP_BASES, type RequirementList } from "../../pipeline.js";
import {
  buildStructuredRequest,
  callStructuredChecked,
  constraintIdsIn,
  isRecord,
  ruleTexts,
  serializeJson,
  shapeRejectedCandidate,
  STEP_ATTEMPTS,
  withReference,
  type Problem,
  type PromptData,
  type PromptDocument,
  type RejectedCandidate,
  type RuleDefinition,
  type ShapeCheck,
  type StageFailure,
} from "../../stages/prompt.js";
import {
  NAME_TABLE_VERIFICATION_KINDS,
  checkCheckTargets,
  checkMappedTable,
  nameTableSha256,
  ownersByRowId,
  ownershipWithCheckTargets,
  shapeOfMappingEntry,
  type MappingEntry,
  type NameTable,
  type NameTableCheckTarget,
  type NameTableOwnership,
  type NameTableRow,
  type NameTableVerification,
} from "../../v11a/names.js";
import { planWithoutRequirementKinds, type SemanticRejection } from "../../v11a/stages/name-table.js";
import type { JudgeAdviceMarkEntry } from "../../v11a/stages/judge-advice.js";
import { ReferenceTally, idKindOf, type ReferenceCounts } from "../ids.js";
import type { UpstreamLedgerView } from "../ledger.js";

/** C2 の JSON Schema の名前 */
export const MAPPING_SCHEMA_NAME = "mapping";

/** C2 の中身の回数（C3 の拒否で 1 回だけ、拒否された要件を書き直す。回すのは呼ぶ側。Issue #661） */
export const MAPPING_ROUNDS = 2;

/** データの塊の名前 */
export const MAPPING_DATA_NAMES = {
  plan: "確定した仕様",
  list: "要件の一覧",
  rows: "表の行",
  documents: "文書",
  response: "前回の写像",
  rejections: "表の点検の拒否",
  advice: "助言の印",
} as const;

/**
 * 落ちた要件だけの書き直しの要求で足すデータの塊の名前（Issue #660。前回の写像は `MAPPING_DATA_NAMES.response`）。C3 の拒否のあとの
 * 2 回目は「書き直す要件」だけを足す（問題は拒否の塊。Issue #661）
 */
export const MAPPING_REWRITE_DATA_NAMES = {
  requirements: "書き直す要件",
  problems: "書き直す要件の問題",
} as const;

/** 書き直しの応答の照合の固定文（Issue #660。C3 の拒否のあとの 2 回目も同じ文。Issue #661。要件 ID の値は文に入れない） */
export const MAPPING_REWRITE_MESSAGES = {
  missing: "書き直す要件の 1 件が無い",
  extra: "書き直す要件のほかの要件を書いた",
  duplicate: "書き直す要件を 2 件書いた",
} as const;

/** C2 の固定文（構造の検査の対象の欄の形。要件の欠落・重複・一覧に無い ID は表の検査 `checkMappedTable` の文） */
export const MAPPING_MESSAGES = {
  checksShape: `checks は検査の種類（${STRUCTURAL_ASSERTIONS.join("・")}）ごとの欄を全部持つ写像か null で、各欄は null か対象の写像の並び（各対象の targetId は空でない文字列。view-shows の対象だけ sourceId も空でない文字列で持ち、ほかの欄の対象は sourceId を持たない）であること`,
  /** 欄が空の並び（Issue #724。使わない種類の欄は null） */
  checksEmpty: "checks の欄は null か 1 件以上の対象の並びであること（使わない種類の欄は null にする）",
} as const;

/** 構造の検査の書き方（R-map-03 と台帳の文の頭で同じ文） */
const STRUCTURAL_RULE_TEXT =
  "構造で確かめるなら kind を structural にし、reason に理由を書く。checks は検査の種類ごとの欄で、各欄は検査の対象の並びである。使う種類の欄に、targetId で検査が見る行の ID（field-type は項目、action-kind・action-unconditioned・write-anonymous は操作、view-shows は画面、aggregate-no-period は計算）を書いた対象を並べ、view-shows の対象は sourceId に画面と同じ entity の項目か計算の行の ID（entity を持たない画面は entity を持たない計算の ID）も書き、使わない種類の欄は空の並びにせず null にする。同じ種類の検査を 2 つ以上の行に掛けて確かめる要件は、その種類の欄に行ごとに 1 件ずつ並べる。同じ組（view-shows は画面と表示元の組、ほかは行）を 2 回書かない。structural は、検査の種類のうち 1 つ以上で確かめられる要件だけである。確かめ方の種類を選ぶ既存の条件（default-value など、専用の種類を指定する文）は今までどおり先に当てる。そのうえで structural にしようとした要件に当たる種類が 1 つも無いなら（行が在ることだけを求める要件など）structural にせず、固定した試験で確かめられるなら fixed-test、宣言で書けず根拠となる文書の制約 ID を一覧から 1 件以上挙げられるなら unresolved にする。欄が全部 null の structural は表の検査で断られる。検査の対象の行はコードが所属に足す。";

/** 書けない要件の書き方（R-map-03 と台帳の文の頭で同じ文。制約 ID の 1 件以上は Issue #682） */
const UNRESOLVED_RULE_TEXT =
  "宣言で書けない要件は kind を unresolved にし、reason に理由、constraintIds に書けない根拠となる文書の制約 ID を 1 件以上（文書の制約 ID の一覧にあるものだけ）書く。根拠となる制約 ID を一覧から挙げられない要件は unresolved にしない。";

/** C2 の規則の定義（ID は `R-map-nn`） */
export const MAPPING_RULE_DEFINITIONS: readonly RuleDefinition[] = [
  {
    id: "R-map-01",
    text: "要件の一覧の要件ごとに 1 件ずつ、requirementId に一覧の要件 ID をそのまま書く。一覧に無い要件 ID を書かない。同じ要件を 2 件書かない。",
    why: "要件を ID で指させ、欠落・重複・一覧に無い ID をコードが照らす（方法論 03 の H2。07 の D10 の写しを廃止する。08 §6）。一覧は全要件を 1 回で渡す（束に切ると各束が表全体の所属の規則を抱えて所属が膨らんだ。08 §9 の手 3 の戻す条件）",
    since: "Issue #593（束ごとの一覧は Issue #594 で足し、Issue #627 で 1 回の写像に戻した）",
  },
  {
    id: "R-map-02",
    text: "roles は、その要件が使う行の所属である。id には表の行の ID をそのまま書く。要件の文が名指しする対象は basis を stated にし reason を null にする。要件の文は名指ししないが実現に要る対象は basis を dependency にし、reason に要る理由を 1 文で書く。項目・計算・操作・画面の所属 entity はコードが足すので書かなくてよい。同じ要件の中で同じ行を 2 回書かない。どの要件にも所属しない行を残さない。",
    why: "所属の根拠を持たせ、共有と entity の所属はコードが導く（T1 の R-nt-07。D9）。行の ID はコードが照らす",
    since: "Issue #593",
  },
  {
    id: "R-map-03",
    text: `verification は要件の確かめ方である。固定した試験で確かめるなら kind を fixed-test にする。${STRUCTURAL_RULE_TEXT}${UNRESOLVED_RULE_TEXT}要件の決まりが選択肢の項目の既定値だけなら kind を default-value にし、value にそのキー（その項目の options のキー）を書き、その項目だけを所属させる。使わない欄は null か空の並びにする。`,
    why: "確かめ方を所属と組で固定し、書けない要件は理由と制約 ID つきで持ち越す（T1 の R-nt-08）。構造の検査の対象は規則の文で所属を求めず、応答の欄で行の ID を書かせて対と所属をコードが導く（方法論 03 の F4・H1・H2）",
    since:
      "Issue #593（構造の検査の対象の欄は Issue #594。検査の種類ごとの欄・同じ種類の検査を 2 つ以上の行に掛ける要件の fixed-test への選び方・未解決の制約 ID の 1 件以上は Issue #682。当たる種類が無い要件を structural にせず fixed-test か unresolved にする選び方は Issue #690。#682 は形の落ち率を理由に 1 種類 1 件とした。fixed-test にすると試験 0 本・操作が未検証になる要件があり（U1 の 30 本の分析）、Issue #724 で契約を対象の並びに広げ、同じ種類の検査を 2 つ以上の行に掛ける要件の fixed-test への選び方を外した）",
  },
  {
    id: "R-map-04",
    text: "nature は要件ごとの種類である。要件の文から分類する：値や振る舞いを縛る決まりを含むなら ruled、そのものが在ればよいなら existence-only にする。前回の写像・表の点検の拒否・助言の印が渡されたときは、拒否が指す要件を直した写像を返す。助言の印は参考であり、印だけを理由に所属を消さない。",
    why: "T2 の独立の分類と照らす元を要件の文だけから作らせ、2 回目に前回の写像と拒否を使わせる（T1 の R-nt-09・R-nt-10）",
    since: "Issue #593",
  },
];

/** 性質の台帳の文を差し込む規則（R-map-03。T1 の R-nt-08 と同じ作法） */
const MAPPING_LEDGER_RULE_HEAD = `verification は要件の確かめ方である。固定した試験で確かめるなら kind を fixed-test にする。${STRUCTURAL_RULE_TEXT}${UNRESOLVED_RULE_TEXT}`;
const MAPPING_LEDGER_RULE_TAIL = "使わない欄は null か空の並びにする。";

/** C2 の規則の定義（旗 `v12.ledger` が on なら R-map-03 を台帳の文で組み直す） */
export function mappingRuleDefinitionsOf(ledger?: UpstreamLedgerView): readonly RuleDefinition[] {
  if (ledger === undefined) return MAPPING_RULE_DEFINITIONS;
  return MAPPING_RULE_DEFINITIONS.map((definition) =>
    definition.id === "R-map-03"
      ? { ...definition, text: `${MAPPING_LEDGER_RULE_HEAD}${ledger.t1RuleTexts.join("")}${MAPPING_LEDGER_RULE_TAIL}` }
      : definition,
  );
}

/**
 * 書き直しの要求の規則（Issue #660。方法論 03 の H3）。**部分の要求だけ**に使う：全件を求める文（R-map-01 の「要件の一覧の
 * 要件ごとに 1 件」）を書き直す要件ごとに 1 件の文に、全行の所属を求める文（R-map-02 の「どの要件にも所属しない行を残さない」）
 * を「所属しない行の条件は合併した表でコードが見る」文に差し替える。ほかの規則の文は同じ。初回と全体の作り直しの要求は今の規則。
 * C3 の拒否のあとの 2 回目も同じ規則（拒否が指す要件を直す文は R-map-04 のまま。Issue #661）
 */
const MAPPING_REWRITE_RULE_DEFINITIONS: Readonly<Record<"R-map-01" | "R-map-02", RuleDefinition>> = {
  "R-map-01": {
    id: "R-map-01r",
    text: "書き直す要件ごとに 1 件ずつ、requirementId にその要件 ID をそのまま書く。書き直す要件のほかの要件を書かない。同じ要件を 2 件書かない。前回の写像のその要件の 1 件を、その要件に帰属した問題を直して書き直す。",
    why: "落ちた要件だけを書き直させ、落ちなかった要件をバイト列で保つ（方法論 03 の H3・H4。書き直す単位を要件にする）。部分に全件を求めると、部分の出力だけで真偽が決まらない条件を部分に課すことになる（#627 の教訓）",
    since: "Issue #660",
  },
  "R-map-02": {
    id: "R-map-02r",
    text: "roles は、その要件が使う行の所属である。id には表の行の ID をそのまま書く。要件の文が名指しする対象は basis を stated にし reason を null にする。要件の文は名指ししないが実現に要る対象は basis を dependency にし、reason に要る理由を 1 文で書く。項目・計算・操作・画面の所属 entity はコードが足すので書かなくてよい。同じ要件の中で同じ行を 2 回書かない。どの要件にも所属しない行の条件は、合併した表でコードが見る。",
    why: "所属の根拠を持たせる文は R-map-02 と同じ。全行の所属は他の要件の出力がなければ真偽が決まらないので部分の規則に書かず、合併後に C2' が見る（#627 の教訓・検討 §4 の R2。孤立行をコードで割り当てない）",
    since: "Issue #660",
  },
};

/** 書き直しの要求の規則の定義（`mappingRuleDefinitionsOf` の R-map-01・R-map-02 だけを部分の文に差し替える。Issue #660） */
export function mappingRewriteRuleDefinitionsOf(ledger?: UpstreamLedgerView): readonly RuleDefinition[] {
  return mappingRuleDefinitionsOf(ledger).map((definition) =>
    definition.id === "R-map-01" || definition.id === "R-map-02" ? MAPPING_REWRITE_RULE_DEFINITIONS[definition.id] : definition,
  );
}

/**
 * 検査の種類ごとの欄の schema（Issue #682・#724）。欄は null か対象の写像の並び（view-shows の要素だけ `{targetId, sourceId}`）。
 * nullable は type に array と null の並びで表す（strict の走査は全節に type を求めるので anyOf を使わない）。空の並びは schema の
 * minItems に頼らず、復号の形の検査で断る
 */
function checkFieldSchemaOf(check: (typeof STRUCTURAL_ASSERTIONS)[number]): Record<string, unknown> {
  const paired = check === "view-shows";
  return {
    type: ["array", "null"],
    items: {
      type: "object",
      additionalProperties: false,
      required: paired ? ["targetId", "sourceId"] : ["targetId"],
      properties: {
        targetId: { type: "string", description: "検査が見る行の ID" },
        ...(paired ? { sourceId: { type: "string", description: "画面と組にする行の ID（画面と同じ entity の項目か計算）" } } : {}),
      },
    },
  };
}

/** 確かめ方の checks の schema：検査の種類ごとの欄（全部 required・固定の順）を持つ写像か null（Issue #682） */
const CHECK_FIELDS_SCHEMA: Record<string, unknown> = {
  type: ["object", "null"],
  additionalProperties: false,
  required: [...STRUCTURAL_ASSERTIONS],
  properties: Object.fromEntries(STRUCTURAL_ASSERTIONS.map((check) => [check, checkFieldSchemaOf(check)])),
};

/**
 * 旧の checks の schema（検査ごとの対象の写像の並び。Issue #594）。**段の要求には使わない。** 識別子 `v1.2` の封筒（旗 ids off の
 * v1.2 の走りが送る封筒）のバイト列を保つためだけに残す（Issue #682 で段の要求は検査の種類ごとの欄に替えた。旧の枝は封筒の
 * C2 の枝としてだけ残り、ids on の走りは識別子 `v1.2-ids` の封筒で新しい枝を送る）
 */
const LEGACY_CHECKS_SCHEMA: Record<string, unknown> = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["check", "targetId", "sourceId"],
    properties: {
      check: { type: "string", enum: [...STRUCTURAL_ASSERTIONS] },
      targetId: { type: "string", description: "検査が見る行の ID" },
      sourceId: { type: ["string", "null"], description: "view-shows の組の行の ID（ほかの検査は null）" },
    },
  },
};

/** C2 の JSON Schema（静的。確かめ方の kind の enum は台帳の種類の並び。strict の規則に合わせる） */
export function mappingSchemaOf(ledger?: UpstreamLedgerView): Record<string, unknown> {
  return mappingSchemaWith(CHECK_FIELDS_SCHEMA, ledger);
}

/**
 * 旧の C2 の JSON Schema（checks が並びの形。Issue #594 の形）。**段の要求には使わない**——識別子 `v1.2` の封筒の C2 の枝を
 * Issue #682 の前とバイト列で同じに保つためだけに使う（`LEGACY_CHECKS_SCHEMA`）
 */
export function legacyMappingSchemaOf(ledger?: UpstreamLedgerView): Record<string, unknown> {
  return mappingSchemaWith(LEGACY_CHECKS_SCHEMA, ledger);
}

function mappingSchemaWith(checks: Record<string, unknown>, ledger?: UpstreamLedgerView): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["requirements"],
    properties: {
      requirements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["requirementId", "roles", "verification", "nature"],
          properties: {
            requirementId: { type: "string", description: "要件の一覧の要件 ID" },
            roles: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "basis", "reason"],
                properties: {
                  id: { type: "string", description: "表の行の ID" },
                  basis: { type: "string", enum: [...ROLE_OWNERSHIP_BASES] },
                  reason: { type: ["string", "null"] },
                },
              },
            },
            verification: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "value", "reason", "checks", "constraintIds"],
              properties: {
                kind: { type: "string", enum: [...(ledger?.verificationKinds ?? NAME_TABLE_VERIFICATION_KINDS)] },
                value: { type: ["string", "null"], description: "確かめ方の値（選択肢のキー。ほかの種類は null）" },
                reason: { type: ["string", "null"] },
                checks,
                constraintIds: { type: "array", items: { type: "string" } },
              },
            },
            nature: { type: "string", enum: [...REQUIREMENT_NATURES] },
          },
        },
      },
    },
  };
}

/** C3 の拒否のあとの 2 回目の材料（書き直す要件は `rejections` の要件 ID の集合。Issue #661） */
export interface MappingPrevious {
  /** 前回の写像（採用した表の応答。合併の元） */
  readonly response: unknown;
  readonly rejections: readonly SemanticRejection[];
  readonly advice: readonly JudgeAdviceMarkEntry[];
}

/** C2 が受け取るもの */
export interface MappingInput {
  readonly plan: ConfirmedPlan;
  readonly list: RequirementList;
  readonly documents: readonly PromptDocument[];
  readonly gateway: CallGateway;
  /** C1 が組んだ行（出典は null） */
  readonly rows: readonly NameTableRow[];
  readonly previous?: MappingPrevious;
  readonly ledger?: UpstreamLedgerView;
  readonly onRejected?: (candidate: MappingRejectedCandidate) => void;
  /**
   * C2' の検査（試験の口。既定は `inspectMappingSourced`）。初回の応答と、書き直しを合併した写像に**同じ検査**を掛けることを、偽物の
   * 検査で数えるためだけに差し込む（Issue #660）
   */
  readonly inspect?: MappingInspector;
}

/** 書き直した要件の数と保持した要件の数（ID の値は持たない。Issue #660・#661） */
export interface MappingRewriteCounts {
  readonly rewritten: number;
  readonly kept: number;
}

/**
 * C2 が断った候補（初回の形のやり直しを落ちた要件だけの書き直しにした回と、C3 の拒否のあとの 2 回目は、書き直した要件と保持した
 * 要件の数を持つ。Issue #660・#661）
 */
export type MappingRejectedCandidate = RejectedCandidate & { readonly rewrite?: MappingRewriteCounts };

/** C2 の結果（整えた表・その SHA-256・整える前の raw の応答・整えた中身）。参照の照合の数は成否によらず返す */
export type MappingOutcome =
  | {
      readonly ok: true;
      readonly value: {
        readonly table: NameTable;
        readonly tableSha256: string;
        readonly response: unknown;
        readonly normalized: readonly MappingNormalization[];
      };
      readonly references: ReferenceCounts;
    }
  | { readonly ok: false; readonly failure: StageFailure; readonly references: ReferenceCounts };

// ── 整える手（Issue #723）──────────────────────────────────────────

/** 整える手の ID */
export type MappingNormalizationRuleId = "N-map-01" | "N-map-02";

/** 手 1 で structural にした要件の reason（固定文） */
export const MAPPING_NORMALIZATION_REASON = "参照の項目 1 つの種類と参照先を構造の検査で確かめる（コードが整えた）";

/**
 * 整える手の定義（LLM には送らない。コードが守ること。`ruleDefinitionDefects` で不備を照らす）。手は表の行（kind・type・
 * refEntity・hasWhen）と basis だけで決まる（方法論 03 の H1・04 §1「コードが決められる事実を規則で指示しない」）
 */
export const MAPPING_NORMALIZATION_DEFINITIONS: readonly (RuleDefinition & { readonly id: MappingNormalizationRuleId })[] = [
  {
    id: "N-map-01",
    text: "確かめ方が fixed-test で、所属（応答の roles に検査の対象を足したもの。導いた entity は含めない）が、type が ref か list で refEntity を持つ項目の行 1 つと、その項目の entity・refEntity の entity の行だけの要件を、kind structural・checks は field-type 1 件・targets はその項目（sourceId null）・reason は固定文にする。所属は変えない。basis は問わない。所属に表に無い ID があれば当てない。",
    why: "「A が B を指す」だけを求める要件は参照の項目 1 行を所属させ、validate の決まりが無いので固定した試験は在ることしか確かめられない。field-type（期待＝種類・refEntity）は表の行から決定的に導ける（コードが作る構造の検査と同じ導き）。C2 は fixed-test に寄り、fixed-test は対象の行を書かないので所属を絞る錨が無い（U1 の 30 本の採点で、fixed-test → 正解が単一行の structural が 21 件）",
    since: "Issue #723",
  },
  {
    id: "N-map-02",
    text: "確かめ方が fixed-test で basis stated の行が 1 つ以上ある要件から、basis dependency・kind operation・hasWhen false の行を外す。その要件の所属に同じ行 ID の重複か表に無い ID があれば当てない。候補の全部を外した表で所属の無い行が新たに出るなら、その行とその行を entity に持つ候補を残して計算し直す。外して 0 行になる要件・全部 dependency の要件は変えない。所属を足さない。",
    why: "台帳の when の行は when の無い操作に action の試験を作らないので、fixed-test の要件が when の無い操作を dependency で所属させても固定した試験の対象にならず、余計な生成試験と網羅の免除に効く（U1 の 30 本の過剰 75 要件のうち 71 件が fixed-test、余計な行は全部ほかの要件が所属させる行）。門の落ち（重複・表に無い ID・孤立行）は消さない（#627：コードで所属を足さない）",
    since: "Issue #723",
  },
];

/** 整えた中身の 1 件（要件ごと。仮に外した分ではなく、整える前の表との最終の差分） */
export interface MappingNormalization {
  readonly requirementId: string;
  readonly rule: MappingNormalizationRuleId;
  /** 手 1 の対象の項目の ID（手 2 は null） */
  readonly targetId: string | null;
  /** 手 2 で外した行 ID（所属の順。手 1 は空） */
  readonly removedRowIds: readonly string[];
}

const isWhenlessOperation = (row: NameTableRow): boolean =>
  row.kind === "operation" && row.type !== null && typeof row.type === "object" && "hasWhen" in row.type && !row.type.hasWhen;

/** 所属の i 番目と確かめ方の i 番目が同じ要件のときだけ、その組の所属（C2 が組む表は同じ並び） */
const pairedRoles = (table: NameTable, index: number): NameTableOwnership["roles"] | undefined => {
  const ownership = table.ownership[index];
  const verification = table.verification[index];
  return ownership !== undefined && verification !== undefined && ownership.requirementId === verification.requirementId ? ownership.roles : undefined;
};

/** 手 1（N-map-01）の対象の項目（当たらなければ undefined） */
function referenceFieldOf(roles: NameTableOwnership["roles"], rowById: ReadonlyMap<string, NameTableRow>): NameTableRow | undefined {
  const owned: NameTableRow[] = [];
  for (const role of roles) {
    const row = rowById.get(role.id);
    if (row === undefined) return undefined;
    owned.push(row);
  }
  const fieldIds = new Set(owned.filter((row) => row.kind === "field").map((row) => row.id));
  if (fieldIds.size !== 1) return undefined;
  const field = owned.find((row) => row.kind === "field") as NameTableRow;
  if ((field.type !== "ref" && field.type !== "list") || field.refEntity === null) return undefined;
  const allowed = owned.every((row) => row.id === field.id || (row.kind === "entity" && (row.id === field.entity || row.id === field.refEntity)));
  return allowed ? field : undefined;
}

/**
 * C2 が組んだ表を整える（純粋。Issue #723）。手 1（N-map-01）→ 手 2（N-map-02）の順に**1 回だけ**当てる（整えた表に再適用しない。
 * 2 手の合成は冪等でない）。表の行・所属の並びは変えず、所属を足さない。手 2 の結果は候補の集合で決まり、要件・行の順に依らない。
 * 当たる要件が無ければ同じ表を返す
 */
export function normalizeMappedTable(table: NameTable): { readonly table: NameTable; readonly normalized: readonly MappingNormalization[] } {
  const rowById = new Map(table.rows.map((row) => [row.id, row] as const));
  // 手 1：参照の項目 1 行の fixed-test → field-type の structural（所属は変えない）
  const firstTargets = new Map<number, string>();
  const verification: NameTableVerification[] = table.verification.map((entry, index) => {
    const roles = pairedRoles(table, index);
    if (entry.kind !== "fixed-test" || roles === undefined) return entry;
    const field = referenceFieldOf(roles, rowById);
    if (field === undefined) return entry;
    firstTargets.set(index, field.id);
    return {
      requirementId: entry.requirementId,
      kind: "structural",
      reason: MAPPING_NORMALIZATION_REASON,
      checks: ["field-type"],
      targets: [{ check: "field-type", targetId: field.id, sourceId: null }],
    };
  });
  const afterFirst: NameTable = firstTargets.size === 0 ? table : { ...table, verification };
  // 手 2：stated のある fixed-test から、dependency の when の無い操作を外す候補（要件の添字ごとの行 ID の集合）
  const candidates = new Map<number, Set<string>>();
  afterFirst.verification.forEach((entry, index) => {
    const roles = pairedRoles(afterFirst, index);
    if (entry.kind !== "fixed-test" || roles === undefined || !roles.some((role) => role.basis === "stated")) return;
    const ids = roles.map((role) => role.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => !rowById.has(id))) return;
    const removable = roles.filter((role) => role.basis === "dependency" && isWhenlessOperation(rowById.get(role.id) as NameTableRow));
    if (removable.length === 0 || removable.length === roles.length) return;
    candidates.set(index, new Set(removable.map((role) => role.id)));
  });
  const without = (active: ReadonlyMap<number, ReadonlySet<string>>): NameTable => ({
    ...afterFirst,
    ownership: afterFirst.ownership.map((entry, index) => {
      const removed = active.get(index);
      return removed === undefined ? entry : { requirementId: entry.requirementId, roles: entry.roles.filter((role) => !removed.has(role.id)) };
    }),
  });
  const ownedBefore = new Set(ownersByRowId(afterFirst).keys());
  let active: Map<number, Set<string>> = candidates;
  // 孤立行を作らない：新たに所属の無い行が出れば、その行とその行を entity に持つ候補を残して計算し直す（候補が減るだけなので止まる）
  while (active.size > 0) {
    const owners = ownersByRowId(without(active));
    const orphans = new Set([...ownedBefore].filter((id) => !owners.has(id)));
    if (orphans.size === 0) break;
    const next = new Map<number, Set<string>>();
    for (const [index, ids] of active) {
      const removing = new Set([...ids].filter((id) => !orphans.has(id) && !orphans.has(rowById.get(id)?.entity ?? "")));
      if (removing.size > 0) next.set(index, removing);
    }
    const before = [...active.values()].reduce((sum, ids) => sum + ids.size, 0);
    const after = [...next.values()].reduce((sum, ids) => sum + ids.size, 0);
    // 減らなければ外さない（孤立の原因が候補に無い。起こらない前提だが、外し続けない）
    active = after < before ? next : new Map();
  }
  const normalized: MappingNormalization[] = [];
  afterFirst.verification.forEach((entry, index) => {
    const target = firstTargets.get(index);
    if (target !== undefined) {
      normalized.push({ requirementId: entry.requirementId, rule: "N-map-01", targetId: target, removedRowIds: [] });
      return;
    }
    const removed = active.get(index);
    if (removed === undefined) return;
    const roles = afterFirst.ownership[index]?.roles ?? [];
    normalized.push({ requirementId: entry.requirementId, rule: "N-map-02", targetId: null, removedRowIds: roles.filter((role) => removed.has(role.id)).map((role) => role.id) });
  });
  return { table: active.size === 0 ? afterFirst : without(active), normalized };
}

/** 骨組み（写像・`requirements` が写像の並び） */
function skeletonProblems(output: unknown): readonly Problem[] {
  if (!isRecord(output)) return [{ field: "", message: "応答は写像（object）であること" }];
  const items = output["requirements"];
  if (!Array.isArray(items)) return [{ field: "requirements", message: "並び（array）であること" }];
  return items.flatMap((item, index) => (isRecord(item) ? [] : [{ field: `requirements[${String(index)}]`, message: "写像（object）であること" }]));
}

/**
 * 応答の確かめ方の検査の種類ごとの欄の対象の写像（種類の固定の順・種類の中は並びの順。写像でない checks は無し）。欄が並びなら
 * 写像の要素を全部、写像なら（形で落ちる応答）その 1 つを数える（Issue #724）
 */
const checkFieldsOf = (entry: Record<string, unknown>): readonly Record<string, unknown>[] => {
  const verification = entry["verification"];
  if (!isRecord(verification)) return [];
  const checks = verification["checks"];
  if (!isRecord(checks)) return [];
  return STRUCTURAL_ASSERTIONS.flatMap((check) => {
    const field = checks[check];
    if (Array.isArray(field)) return (field as readonly unknown[]).filter(isRecord);
    return isRecord(field) ? [field] : [];
  });
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * checks（検査の種類ごとの欄）を、種類の固定の順（`STRUCTURAL_ASSERTIONS`）・種類の中は応答の順の検査の対象の並びに写す
 * （Issue #682・#724）。null は空の並び。欄が欠ける・余る、欄が null でも並びでもない、要素が対象の写像でない、targetId・view-shows
 * の sourceId が空でない文字列でない、view-shows でない欄の要素が sourceId を持つ、のどれかなら形が合わない（`shape`）。欄が空の
 * 並びなら `empty`。重なり（同じ組が 2 回）は落とさない（表の検査が断る）
 */
function readCheckFields(checks: unknown): readonly NameTableCheckTarget[] | "shape" | "empty" {
  if (checks === null) return [];
  if (!isRecord(checks) || !hasExactKeys(checks, STRUCTURAL_ASSERTIONS)) return "shape";
  const targets: NameTableCheckTarget[] = [];
  let empty = false;
  for (const check of STRUCTURAL_ASSERTIONS) {
    const field = checks[check];
    if (field === null) continue;
    if (!Array.isArray(field)) return "shape";
    if (field.length === 0) empty = true;
    const paired = check === "view-shows";
    for (const item of field as readonly unknown[]) {
      if (!isRecord(item)) return "shape";
      if (!hasExactKeys(item, paired ? ["targetId", "sourceId"] : ["targetId"]) || !isNonEmptyString(item["targetId"])) return "shape";
      if (paired && !isNonEmptyString(item["sourceId"])) return "shape";
      targets.push({ check, targetId: item["targetId"], sourceId: paired ? (item["sourceId"] as string) : null });
    }
  }
  return empty ? "empty" : targets;
}

/** 応答の参照を数える（純粋。ID の値は数に入れない） */
export function countMappingReferences(list: RequirementList, rows: readonly NameTableRow[], output: unknown, tally: ReferenceTally): void {
  if (!isRecord(output) || !Array.isArray(output["requirements"])) return;
  const requirementIds = new Set(list.requirements.map((requirement) => requirement.id));
  const rowIds = new Set(rows.map((row) => row.id));
  const seenRequirements = new Set<string>();
  /** 行を指す欄の ID（所属・検査の対象）を数える。`seen` を渡せば重複を数える */
  const countRowId = (id: unknown, seen?: Set<string>): void => {
    if (typeof id !== "string") return;
    tally.checked += 1;
    if (!rowIds.has(id)) {
      if (requirementIds.has(id)) tally.crossBundle += 1;
      else tally.unknown += 1;
    } else if (seen?.has(id) === true) tally.duplicate += 1;
    seen?.add(id);
  };
  for (const entry of output["requirements"] as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const requirementId = entry["requirementId"];
    if (typeof requirementId === "string") {
      tally.checked += 1;
      if (!requirementIds.has(requirementId)) {
        if (idKindOf(requirementId) !== null) tally.crossBundle += 1;
        else tally.unknown += 1;
      } else if (seenRequirements.has(requirementId)) tally.duplicate += 1;
      seenRequirements.add(requirementId);
    }
    const roles = Array.isArray(entry["roles"]) ? (entry["roles"] as readonly unknown[]) : [];
    const seenRoles = new Set<string>();
    for (const role of roles) countRowId(isRecord(role) ? role["id"] : undefined, seenRoles);
    for (const field of checkFieldsOf(entry)) {
      countRowId(field["targetId"]);
      countRowId(field["sourceId"]);
    }
  }
}

/**
 * 応答の要件ごとの 1 件の形（検査の種類ごとの欄を読んで種類の固定の順の並びに写し、所属・確かめ方・分類の形は T1 の下書きと同じ
 * 関数）。構造で確かめる要件は確かめ方に対象を持たせる。合わなければ問題に足して undefined
 */
function shapeOfEntry(
  value: unknown,
  field: string,
  problems: Problem[],
  ledger?: UpstreamLedgerView,
): MappingEntry | undefined {
  let targets: readonly NameTableCheckTarget[] | undefined;
  let item = value;
  if (isRecord(value) && isRecord(value["verification"])) {
    const verification = value["verification"];
    const read = readCheckFields(verification["checks"]);
    if (typeof read === "string") {
      problems.push({ field: `${field}.verification.checks`, message: read === "shape" ? MAPPING_MESSAGES.checksShape : MAPPING_MESSAGES.checksEmpty });
      return undefined;
    }
    targets = read;
    item = { ...value, verification: { ...verification, checks: read.map((target) => target.check) } };
  }
  const entry = shapeOfMappingEntry(item, field, problems, ledger === undefined ? {} : { ledger });
  if (entry === undefined || entry.verification.kind !== "structural") return entry;
  return { ...entry, verification: { ...entry.verification, targets: targets ?? [] } };
}

/**
 * C2' の問題の出どころ（Issue #660）。`response` は応答の位置（整形と検査の対象の照合。欄は応答の `requirements[j]`）、`table` は
 * 表の検査（`checkMappedTable`。欄は表の位置〔所属・確かめ方・分類の i 番目〕か一覧の位置の欠落〔`requirements[i]`〕か行）
 */
export type MappingProblemSource = "response" | "table";

/** C2' の結果に、問題ごとの出どころと検査した表の要件 ID の並びを足したもの（Issue #660。帰属の入力） */
export type MappingInspection =
  | { readonly ok: true; readonly table: NameTable; readonly normalized: readonly MappingNormalization[] }
  | {
      readonly ok: false;
      readonly problems: readonly Problem[];
      /** `problems` と同じ並びの出どころ */
      readonly sources: readonly MappingProblemSource[];
      /** 検査した表の entry の要件 ID（所属・確かめ方・分類は同じ並び）。表を組む前に落ちたときは null */
      readonly tableRequirementIds: readonly string[] | null;
    };

/** C2' の検査の型（`inspectMappingSourced` と同じ。試験の口で差し込む） */
export type MappingInspector = (
  list: RequirementList,
  rows: readonly NameTableRow[],
  output: Record<string, unknown>,
  documents: readonly PromptDocument[],
  ledger?: UpstreamLedgerView,
) => MappingInspection;

/**
 * 応答（骨組みは通った）から表を組み、C2' を掛ける（純粋）。構造の検査の対象を照らして通った対象の行を所属に足し（対象の問題の
 * 位置は応答の `requirements[j]`）、一覧の順に並べた表を整え（`normalizeMappedTable`。Issue #723）、整えた表に C2' を掛ける（表の
 * 問題の位置は表の欄。手 3a と同じ。整える手は並びを変えない）
 */
export function inspectMapping(
  list: RequirementList,
  rows: readonly NameTableRow[],
  output: Record<string, unknown>,
  documents: readonly PromptDocument[],
  ledger?: UpstreamLedgerView,
):
  | { readonly ok: true; readonly table: NameTable; readonly normalized: readonly MappingNormalization[] }
  | { readonly ok: false; readonly problems: readonly Problem[] } {
  const inspected = inspectMappingSourced(list, rows, output, documents, ledger);
  return inspected.ok ? inspected : { ok: false, problems: inspected.problems };
}

/** `inspectMapping` と同じ検査・同じ問題に、問題ごとの出どころと検査した表の要件 ID を足して返す（純粋。Issue #660） */
export function inspectMappingSourced(
  list: RequirementList,
  rows: readonly NameTableRow[],
  output: Record<string, unknown>,
  documents: readonly PromptDocument[],
  ledger?: UpstreamLedgerView,
): MappingInspection {
  const problems: Problem[] = [];
  const shaped = (output["requirements"] as readonly unknown[]).map((item, index) => shapeOfEntry(item, `requirements[${String(index)}]`, problems, ledger));
  if (problems.length > 0) return { ok: false, problems, sources: problems.map(() => "response"), tableRequirementIds: null };
  // 検査の対象を照らして所属に足す（対象に問題がある要件は足さない。落ちる応答は採用しない）
  const entries = (shaped as readonly MappingEntry[]).map((entry, index) => {
    if (entry.verification.kind !== "structural" || entry.verification.targets === undefined) return entry;
    const before = problems.length;
    checkCheckTargets(rows, entry.verification.targets, `requirements[${String(index)}].verification`, problems);
    return problems.length !== before ? entry : { ...entry, roles: ownershipWithCheckTargets(entry.roles, entry.verification.targets) };
  });
  // 一覧の順に並べる（応答の順は表の SHA に効かせない。重複・一覧に無い ID は応答の順のまま後ろに置き、C2' が落とす）
  const order = new Map(list.requirements.map((requirement, index) => [requirement.id, index] as const));
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (order.get(a.entry.requirementId) ?? list.requirements.length + a.index) - (order.get(b.entry.requirementId) ?? list.requirements.length + b.index) || a.index - b.index)
    .map(({ entry }) => entry);
  const built: NameTable = {
    rows,
    ownership: sorted.map((entry) => ({ requirementId: entry.requirementId, roles: entry.roles })),
    verification: sorted.map((entry) => ({ ...entry.verification, requirementId: entry.requirementId })),
    classification: sorted.map((entry) => ({ requirementId: entry.requirementId, nature: entry.nature })),
  };
  // 整える手は C2' の前に、組んだ表へ 1 回だけ当てる（門は整えた表に今のまま掛ける。Issue #723）
  const { table, normalized } = normalizeMappedTable(built);
  const sources: MappingProblemSource[] = problems.map(() => "response");
  const tableProblems = checkMappedTable(list, table, documents, ledger === undefined ? {} : { ledger });
  problems.push(...tableProblems);
  sources.push(...tableProblems.map((): MappingProblemSource => "table"));
  return problems.length > 0
    ? { ok: false, problems, sources, tableRequirementIds: sorted.map((entry) => entry.requirementId) }
    : { ok: true, table, normalized };
}

/** 要件 1 件に帰属した問題（Issue #660） */
export interface MappingProblemGroup {
  readonly requirementId: string;
  readonly problems: readonly Problem[];
}

/** 帰属の結果。`requirementIds` は問題ごとの要件 ID（帰属できなければ null）、`groups` は全部帰属できたときだけ一覧の順の組 */
export interface MappingAttribution {
  readonly requirementIds: readonly (string | null)[];
  readonly groups: readonly MappingProblemGroup[] | null;
}

const RESPONSE_POSITION = /^requirements\[(\d+)\](?:\.|$)/;
const LIST_POSITION = /^requirements\[(\d+)\]$/;
const TABLE_POSITION = /^(?:ownership|verification|classification)\[(\d+)\](?:\.|$)/;

/**
 * C2' の問題を要件へ帰属させる（純粋。Issue #660）。出どころごとに位置を読む：
 *   - 応答の位置（`response` の `requirements[j]…`）：応答の j 番目の entry の要件 ID
 *   - 表の位置（`table` の `ownership|verification|classification[i]…`）：検査した表の i 番目の entry の要件 ID（欠落した要件は
 *     表に無いので、一覧の添字に直結しない）
 *   - 一覧の位置の欠落（`table` の `requirements[i]`）：一覧の i 番目の要件 ID
 * 要件 ID が一覧に無い・応答か表に 2 回ある entry の問題、行の問題（孤立行など）、ほかの欄は帰属できない（推測しない）。
 * `groups` は、問題が全部帰属でき、応答の要件 ID が全部一覧にあって重複せず（表を組む前に落ちた応答は一覧の要件を全部持ち）、
 * 合併に使えるときだけ返す。
 */
export function attributeMappingProblems(
  list: RequirementList,
  output: Record<string, unknown>,
  inspection: Extract<MappingInspection, { readonly ok: false }>,
): MappingAttribution {
  const listed = new Set(list.requirements.map((requirement) => requirement.id));
  const responseIds = (Array.isArray(output["requirements"]) ? (output["requirements"] as readonly unknown[]) : []).map((entry) =>
    isRecord(entry) && typeof entry["requirementId"] === "string" ? entry["requirementId"] : null,
  );
  const occurrences = (ids: readonly (string | null)[], id: string): number => ids.filter((other) => other === id).length;
  /** 一覧にあり、並びにちょうど 1 回だけ現れる要件 ID（帰属してよい entry） */
  const uniqueListed = (ids: readonly (string | null)[], index: number): string | null => {
    const id = ids[index];
    return id !== undefined && id !== null && listed.has(id) && occurrences(ids, id) === 1 ? id : null;
  };
  const requirementIds = inspection.problems.map((problem, index): string | null => {
    if (inspection.sources[index] === "response") {
      const at = RESPONSE_POSITION.exec(problem.field);
      return at === null ? null : uniqueListed(responseIds, Number(at[1]));
    }
    const missing = LIST_POSITION.exec(problem.field);
    if (missing !== null) return list.requirements[Number(missing[1])]?.id ?? null;
    const at = TABLE_POSITION.exec(problem.field);
    return at === null || inspection.tableRequirementIds === null ? null : uniqueListed(inspection.tableRequirementIds, Number(at[1]));
  });
  // 応答の要件 ID が一覧の外・重複なら（問題に出ていなくても）帰属できない。整形で落ちて表を組む前に止まった応答は欠落も表の検査に
  // 出ていないので、一覧の要件が全部ある応答に限る（保持する要件を補わない・落とさない）
  const wellFormed = responseIds.every((id, index) => uniqueListed(responseIds, index) === id && id !== null);
  const complete = inspection.tableRequirementIds !== null || list.requirements.every((requirement) => responseIds.includes(requirement.id));
  if (!wellFormed || !complete || requirementIds.some((id) => id === null)) return { requirementIds, groups: null };
  const groups = list.requirements.flatMap((requirement) => {
    const problems = inspection.problems.filter((_, index) => requirementIds[index] === requirement.id);
    return problems.length === 0 ? [] : [{ requirementId: requirement.id, problems }];
  });
  return { requirementIds, groups };
}

/**
 * 書き直しの応答（骨組みは通った）の要件 ID の集合を、書き直す要件と照らす（純粋。Issue #660 の R5）。欠落・余分・重複は固定文
 * （要件 ID の値は文に入れない）
 */
export function checkRewriteResponse(rewrite: readonly string[], output: Record<string, unknown>): readonly Problem[] {
  const problems: Problem[] = [];
  const wanted = new Set(rewrite);
  const seen = new Set<string>();
  (output["requirements"] as readonly Record<string, unknown>[]).forEach((entry, index) => {
    const id = entry["requirementId"];
    const field = `requirements[${String(index)}].requirementId`;
    if (typeof id !== "string" || !wanted.has(id)) problems.push({ field, message: MAPPING_REWRITE_MESSAGES.extra });
    else if (seen.has(id)) problems.push({ field, message: MAPPING_REWRITE_MESSAGES.duplicate });
    if (typeof id === "string") seen.add(id);
  });
  rewrite.forEach((id, index) => {
    if (!seen.has(id)) problems.push({ field: `rewrite[${String(index)}]`, message: MAPPING_REWRITE_MESSAGES.missing });
  });
  return problems;
}

/**
 * 前回の応答と書き直しの応答を合併する（純粋。Issue #660）。書き直す要件は書き直しの応答の entry、ほかの要件は前回の応答の entry
 * （同じ値。書き換えない・補わない）で、並びは一覧の順。書き直しの応答は `checkRewriteResponse` を通ったものに限る
 */
export function mergeRewrite(
  list: RequirementList,
  previous: Record<string, unknown>,
  rewrite: readonly string[],
  rewritten: Record<string, unknown>,
): { readonly requirements: readonly unknown[] } {
  const wanted = new Set(rewrite);
  const idOf = (entry: unknown): unknown => (isRecord(entry) ? entry["requirementId"] : undefined);
  const previousEntries = previous["requirements"] as readonly unknown[];
  const rewrittenEntries = rewritten["requirements"] as readonly unknown[];
  return {
    requirements: list.requirements.flatMap((requirement) =>
      (wanted.has(requirement.id) ? rewrittenEntries : previousEntries).filter((entry) => idOf(entry) === requirement.id),
    ),
  };
}

function rawResponseText(output: unknown): string {
  return serializeJson(output).replaceAll("<", "\\u003c");
}

/** C2 の要求のデータ（`previous` があればこの順で 3 塊を足す） */
function buildData(input: MappingInput): readonly PromptData[] {
  const data: PromptData[] = [
    { name: MAPPING_DATA_NAMES.plan, text: serializeJson(planWithoutRequirementKinds(input.plan)) },
    {
      name: MAPPING_DATA_NAMES.list,
      text: serializeJson({
        requirements: input.list.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text, quote: requirement.quote })),
      }),
    },
    {
      name: MAPPING_DATA_NAMES.rows,
      // 名前は見せない（C2・C3・T2 に名前を見せない）
      text: serializeJson(
        input.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          entity: row.entity,
          role: row.role,
          type: row.type,
          options: row.options,
          groupBy: row.groupBy,
          refEntity: row.refEntity,
        })),
      ),
    },
    {
      name: MAPPING_DATA_NAMES.documents,
      text: serializeJson({ names: input.documents.map((document) => document.name), constraintIds: [...constraintIdsIn(input.documents)] }),
    },
  ];
  const previous = input.previous;
  if (previous !== undefined) {
    data.push({ name: MAPPING_DATA_NAMES.response, text: rawResponseText(previous.response) });
    data.push({
      name: MAPPING_DATA_NAMES.rejections,
      text: serializeJson(previous.rejections.map((rejection) => ({ requirementId: rejection.requirementId, kind: rejection.kind, quote: rejection.quote }))),
    });
    data.push({
      name: MAPPING_DATA_NAMES.advice,
      text: serializeJson(previous.advice.map((entry) => ({ requirementId: entry.requirementId, id: entry.id, mark: entry.mark }))),
    });
  }
  return data;
}

/** 書き直しの要求のデータ（初回のデータの後ろに、前回の写像・書き直す要件・その問題の 3 塊を足す。Issue #660） */
function buildRewriteData(input: MappingInput, previous: unknown, groups: readonly MappingProblemGroup[]): readonly PromptData[] {
  return [
    ...buildData(input),
    { name: MAPPING_DATA_NAMES.response, text: rawResponseText(previous) },
    { name: MAPPING_REWRITE_DATA_NAMES.requirements, text: serializeJson(groups.map((group) => group.requirementId)) },
    {
      name: MAPPING_REWRITE_DATA_NAMES.problems,
      text: serializeJson(
        groups.map((group) => ({
          requirementId: group.requirementId,
          problems: group.problems.map((problem) => ({
            field: problem.field,
            ...(problem.code === undefined ? {} : { code: problem.code }),
            message: problem.message,
          })),
        })),
      ),
    },
  ];
}

/** C3 の拒否のあとの 2 回目の要求のデータ（前回の写像・拒否・印の 3 塊の後ろに、書き直す要件を足す。Issue #661） */
function buildRejectedRewriteData(input: MappingInput, rewrite: readonly string[]): readonly PromptData[] {
  return [...buildData(input), { name: MAPPING_REWRITE_DATA_NAMES.requirements, text: serializeJson(rewrite) }];
}

/** C3 が拒否した要件 ID の集合を一覧の順に並べる（純粋。拒否の種類に依らず全部。Issue #661） */
export function rejectedRequirementIds(list: RequirementList, rejections: readonly SemanticRejection[]): readonly string[] {
  const rejected = new Set(rejections.map((rejection) => rejection.requirementId));
  return list.requirements.filter((requirement) => rejected.has(requirement.id)).map((requirement) => requirement.id);
}

/** 初回の検査の結果：表、または落ちた要件だけを書き直す予定（Issue #660） */
type FirstCheck =
  | { readonly kind: "table"; readonly table: NameTable; readonly normalized: readonly MappingNormalization[] }
  | { readonly kind: "rewrite"; readonly problems: readonly Problem[]; readonly groups: readonly MappingProblemGroup[] };

/**
 * C2 を 1 回回す。初回は C2' に落ちれば 1 回だけ作り直させ、2 回続けば `unmet`（骨組みの形が続けば `malformed`）。作り直しは、
 * 問題が全部要件へ帰属できれば落ちた要件だけの書き直し（合併して C2' を全部掛ける）、そうでなければ共通の窓口の形のやり直し
 * （全体。Issue #660）。`previous` を渡した 2 回目は C3 が拒否した要件だけを 1 回だけ書き直させ、合併して C2' を全部掛ける。
 * どこかで落ちれば `unmet`（`attempts` 1。Issue #661）。
 */
export async function runMapping(input: MappingInput): Promise<MappingOutcome> {
  const { ledger } = input;
  const inspector = input.inspect ?? inspectMappingSourced;
  const tally = new ReferenceTally();
  if (input.previous !== undefined) return rewriteRejectedRequirements(input, input.previous, tally);
  let lastWasSkeleton = false;
  const inspectSourced = (output: unknown): MappingInspection | { readonly ok: false; readonly problems: readonly Problem[]; readonly skeleton: true } => {
    const skeleton = skeletonProblems(output);
    lastWasSkeleton = skeleton.length > 0;
    if (skeleton.length > 0) return { ok: false, problems: skeleton, skeleton: true };
    countMappingReferences(input.list, input.rows, output, tally);
    return inspector(input.list, input.rows, output as Record<string, unknown>, input.documents, ledger);
  };
  const request = buildStructuredRequest({
    rules: ruleTexts(mappingRuleDefinitionsOf(ledger)),
    documents: input.documents,
    data: buildData(input),
    schemaName: MAPPING_SCHEMA_NAME,
    schema: mappingSchemaOf(ledger),
    maxOutputTokens: input.gateway.maxOutputTokens("name-table"),
  });
  const onRejected = input.onRejected;
  const onShapeRejected =
    onRejected === undefined ? {} : { onShapeRejected: (rejection: Parameters<typeof shapeRejectedCandidate>[1]) => onRejected(shapeRejectedCandidate(1, rejection)) };
  // 初回：1 回目の試行の問題が全部要件へ帰属できれば、窓口の形のやり直しに入らずに返し（下で書き直す）、帰属できなければ今までどおり
  // 窓口が全体を作り直させる（要求は今とバイト列で同じ）。2 回目の試行の検査は今のまま
  let attempts = 0;
  const firstCheck = (output: unknown): ShapeCheck<FirstCheck> => {
    attempts += 1;
    const inspected = inspectSourced(output);
    if (inspected.ok) return { ok: true, value: { kind: "table", table: inspected.table, normalized: inspected.normalized } };
    if (attempts === 1 && !("skeleton" in inspected)) {
      const { groups } = attributeMappingProblems(input.list, output as Record<string, unknown>, inspected);
      if (groups !== null) return { ok: true, value: { kind: "rewrite", problems: inspected.problems, groups } };
    }
    return { ok: false, problems: inspected.problems };
  };
  const answer = await callStructuredChecked(input.gateway, { request, check: firstCheck, ...onShapeRejected });
  if (answer.ok) {
    const first = answer.value;
    if (first.kind === "rewrite") return rewriteFailedRequirements(input, request, answer.output as Record<string, unknown>, first, tally);
    return {
      ok: true,
      value: { table: first.table, tableSha256: await nameTableSha256(first.table), response: answer.output, normalized: first.normalized },
      references: tally.counts,
    };
  }
  const failure: StageFailure =
    answer.failure.kind === "malformed" && !lastWasSkeleton
      ? { kind: "unmet", attempts: answer.failure.attempts, problems: answer.failure.problems }
      : answer.failure;
  return { ok: false, failure, references: tally.counts };
}

/**
 * 初回の応答の問題が全部帰属できたときの形のやり直し（Issue #660）。落ちた要件だけを書き直させ（部分専用の規則・前回の写像・書き直す
 * 要件・その問題。schema と前置きの文書は初回と同じ）、応答の要件 ID の集合を照らし、前回の応答の残りと一覧の順に合併して C2' を
 * 全部掛ける。どこかで落ちれば追加の要求なく `unmet`（骨組みの形なら `malformed`）。試行の数は窓口の形のやり直しと同じ 2
 */
async function rewriteFailedRequirements(
  input: MappingInput,
  request: ReturnType<typeof buildStructuredRequest>,
  previous: Record<string, unknown>,
  first: Extract<FirstCheck, { readonly kind: "rewrite" }>,
  tally: ReferenceTally,
): Promise<MappingOutcome> {
  const rewrite = first.groups.map((group) => group.requirementId);
  const counts: MappingRewriteCounts = { rewritten: rewrite.length, kept: input.list.requirements.length - rewrite.length };
  const reject = (attempt: number, response: unknown, problems: readonly Problem[]): void =>
    input.onRejected?.({ kind: "shape", round: 1, attempt, response, problems: withReference(problems, "response"), rewrite: counts });
  reject(1, previous, first.problems);
  // 形が合わなかったので 1 回だけやり直す。この**やり直し**を共通の口へ告げる（窓口の形のやり直しと同じ数え方。Issue #446）
  input.gateway.noteRetry("shape");
  const rewriteRequest = buildStructuredRequest({
    rules: ruleTexts(mappingRewriteRuleDefinitionsOf(input.ledger)),
    documents: input.documents,
    data: buildRewriteData(input, previous, first.groups),
    schemaName: MAPPING_SCHEMA_NAME,
    schema: mappingSchemaOf(input.ledger),
    maxOutputTokens: request.maxOutputTokens,
  });
  const answer = await callStructuredChecked(input.gateway, { request: rewriteRequest, check: (output) => ({ ok: true, value: output }) });
  if (!answer.ok) return { ok: false, failure: answer.failure, references: tally.counts };
  const output = answer.output;
  const skeleton = skeletonProblems(output);
  if (skeleton.length > 0) {
    reject(2, output, skeleton);
    return { ok: false, failure: { kind: "malformed", attempts: STEP_ATTEMPTS, problems: skeleton }, references: tally.counts };
  }
  // 参照の照合の数は実際の応答（書き直した k 件）を数える（保持した要件を新たな応答として数えない）
  countMappingReferences(input.list, input.rows, output, tally);
  const mismatch = checkRewriteResponse(rewrite, output as Record<string, unknown>);
  if (mismatch.length > 0) {
    reject(2, output, mismatch);
    return { ok: false, failure: { kind: "unmet", attempts: STEP_ATTEMPTS, problems: mismatch }, references: tally.counts };
  }
  const merged = mergeRewrite(input.list, previous, rewrite, output as Record<string, unknown>);
  // 合併した写像に C2' を全部掛ける（孤立行・網羅・重複を含む。初回と同じ検査）
  const inspected = (input.inspect ?? inspectMappingSourced)(input.list, input.rows, merged, input.documents, input.ledger);
  if (!inspected.ok) {
    reject(2, merged, inspected.problems);
    return { ok: false, failure: { kind: "unmet", attempts: STEP_ATTEMPTS, problems: inspected.problems }, references: tally.counts };
  }
  return {
    ok: true,
    value: { table: inspected.table, tableSha256: await nameTableSha256(inspected.table), response: merged, normalized: inspected.normalized },
    references: tally.counts,
  };
}

/**
 * C3 の拒否のあとの 2 回目（Issue #661。方法論 03 の H3・H4）。C3 が拒否した要件だけを書き直させ（部分専用の規則・前回の写像・拒否・
 * 印・書き直す要件。schema と前置きの文書は初回と同じ）、1 回だけ呼ぶ（形の再試行は無い。08 §4.1）。応答の要件 ID の集合を照らし、
 * 前回の写像の残りの要件（バイト列で同じ）と一覧の順に合併して C2' を全部掛ける。どこかで落ちれば追加の要求なく `unmet`
 * （`attempts` 1。骨組みの崩れも直す前と同じく `unmet`）
 */
async function rewriteRejectedRequirements(
  input: MappingInput,
  previous: MappingPrevious,
  tally: ReferenceTally,
): Promise<MappingOutcome> {
  const rewrite = rejectedRequirementIds(input.list, previous.rejections);
  const counts: MappingRewriteCounts = { rewritten: rewrite.length, kept: input.list.requirements.length - rewrite.length };
  const unmet = (response: unknown, problems: readonly Problem[]): MappingOutcome => {
    input.onRejected?.({ kind: "shape", round: 2, attempt: 1, response, problems: withReference(problems, "response"), rewrite: counts });
    return { ok: false, failure: { kind: "unmet", attempts: 1, problems }, references: tally.counts };
  };
  const request = buildStructuredRequest({
    rules: ruleTexts(mappingRewriteRuleDefinitionsOf(input.ledger)),
    documents: input.documents,
    data: buildRejectedRewriteData(input, rewrite),
    schemaName: MAPPING_SCHEMA_NAME,
    schema: mappingSchemaOf(input.ledger),
    maxOutputTokens: input.gateway.maxOutputTokens("name-table"),
  });
  const answer = await callStructuredChecked(input.gateway, { request, check: (output) => ({ ok: true, value: output }) });
  if (!answer.ok) return { ok: false, failure: answer.failure, references: tally.counts };
  const output = answer.output;
  const skeleton = skeletonProblems(output);
  if (skeleton.length > 0) return unmet(output, skeleton);
  // 参照の照合の数は実際の応答（書き直した k 件）を数える（保持した要件を新たな応答として数えない）
  countMappingReferences(input.list, input.rows, output, tally);
  const mismatch = checkRewriteResponse(rewrite, output as Record<string, unknown>);
  if (mismatch.length > 0) return unmet(output, mismatch);
  const merged = mergeRewrite(input.list, previous.response as Record<string, unknown>, rewrite, output as Record<string, unknown>);
  // 合併した写像に C2' を全部掛ける（孤立行・網羅・重複を含む。初回と同じ検査）
  const inspected = (input.inspect ?? inspectMappingSourced)(input.list, input.rows, merged, input.documents, input.ledger);
  if (!inspected.ok) return unmet(merged, inspected.problems);
  return {
    ok: true,
    value: { table: inspected.table, tableSha256: await nameTableSha256(inspected.table), response: merged, normalized: inspected.normalized },
    references: tally.counts,
  };
}
