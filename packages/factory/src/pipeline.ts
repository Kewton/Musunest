// 段（パイプライン）の型（02-architecture.md §1・§1.4）。
//
// 外側（段の順番・記録・打ち切り・合否）はコードが決め、内側の「書く・直す」段だけを LLM に任せる。
// ここは ① 要件にする 〜 ⑧ 納品物にする の**入力と出力の型**と、前半（①'・②'）から持ち越した未達を
// ⑦ の入力へ写す**純粋な関数**を置く。段の中身（プロンプト・道具）は stages/ にある。
import type { ConfirmedPlan, NormalizedAppSpec, PlanPartDisposition } from "@musunest/appspec-schema";
import type { Diagnostic } from "@musunest/spec-engine";
import type { RequirementNature, TestSuite, TestTargetKind } from "./fixed-test.js";
import type { Outcome, StageResults } from "./outcome.js";

/** 原文の中の文字の範囲（① で付ける引用の位置） */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 確定した仕様（`plan.json`）の要件の**部分**（Issue #334）。Plan の `parts[]` を写したもので、
 * 設計の `unwritable` を `accepted_unwritable`（部分 ID）と突き合わせるのに使う。
 */
export interface RequirementPart {
  readonly id: string;
  readonly text: string;
  readonly disposition: PlanPartDisposition;
}

/** 1 行 1 要件。原文の引用と位置を付ける（①。F-3） */
export interface Requirement {
  readonly id: string;
  readonly text: string;
  readonly quote: string;
  readonly position: SourceRange;
  /**
   * 確定した仕様の部分（Plan の `parts[]`。Issue #334）。**確定した仕様を正本にしたときだけ入る**
   * （原文から作った一覧では省く）。設計が「書けない」と申告した部分を、了承して除いた部分（部分 ID）と
   * 突き合わせるのに使う。
   */
  readonly parts?: readonly RequirementPart[];
}

/** ① 要件にする、の出力 */
export interface RequirementList {
  readonly requirements: readonly Requirement[];
  /** 軽い曖昧さについて、どちらに決めたかの記録（F-6） */
  readonly decisions: readonly string[];
  /** 重大な曖昧さ。決めずに「未解決」として最後まで持つ（F-6） */
  readonly unresolved: readonly string[];
}

/**
 * 確定した仕様（Plan の契約 `ConfirmedPlan`）から、Build の全段が使う要件の一覧を作る（§5・Issue #334）。
 *
 * **確定した仕様があるときは ① と ①' を行わず、その要件をそのまま使う**（§5・Issue #334）。要件の文は
 * 仕様の `text`、引用は `origin.quote`（出どころ）を写す。原文の位置は確定した仕様には無いので
 * `{ 0, 0 }` とし、①' を行わないので位置の一致は確かめない。部分（`parts`）は、設計の `unwritable` を
 * `accepted_unwritable`（部分 ID）と突き合わせるために写す。
 */
export function requirementsFromPlan(plan: ConfirmedPlan): RequirementList {
  return {
    requirements: plan.requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      quote: requirement.origin.quote,
      position: { start: 0, end: 0 },
      parts: requirement.parts.map((part) => ({
        id: part.id,
        text: part.text,
        disposition: part.disposition,
      })),
    })),
    decisions: plan.decisions.map((decision) => `${decision.subject}: ${decision.value}`),
    unresolved: [],
  };
}

/**
 * 了承して除いた部分（`accepted_unwritable`）の**部分 ID** を集める（§5・Issue #334）。
 * 設計が「書けない」と申告した部分が、この集合の内側なら「了承済み」、外なら「Plan の見落とし」である。
 */
export function acceptedUnwritablePartIds(plan: ConfirmedPlan): ReadonlySet<string> {
  return new Set(plan.accepted_unwritable.map((entry) => entry.part_id));
}

/**
 * ①' 逆照合で見つかった 1 つの落ち（02 §1・§1.2）。
 *
 * 引用の実在・位置の一致は**コードが**原文と突き合わせて見つける。覆われていない原文の文も、
 * コードが原文を文に切り分けて見つける（会話の申告だけに頼らない）。落ちの種類を判別できる形にして、
 * ① のやり直しに渡し、やり直しても残れば未達として持つ。
 */
export type ReverseCheckMiss =
  /** 引用が原文に実在しない */
  | { readonly kind: "quote-not-found"; readonly requirementId: string; readonly detail: string }
  /** 引用は実在するが、位置（文字の範囲）が合わない */
  | { readonly kind: "position-mismatch"; readonly requirementId: string; readonly detail: string }
  /** どの要件の位置にも覆われていない原文の文 */
  | { readonly kind: "uncovered-source"; readonly range: SourceRange; readonly detail: string };

/** ①' 逆照合、の出力（原文と一覧だけを渡した別の会話＋コード） */
export interface ReverseCheckResult {
  /** 一覧のどれにも対応しない原文の部分（コードが見つけた分と、会話が挙げた分） */
  readonly uncovered: readonly SourceRange[];
  /** 引用が原文に実在し、位置が合ったか（コードが確かめる） */
  readonly quotesValid: boolean;
  /** 見つかった落ち（① のやり直しと、未達の持ち越しに使う） */
  readonly misses: readonly ReverseCheckMiss[];
}

/**
 * 要件ごとの確かめ方（② が固定する。§1・②・Issue #307）。
 *
 * - `fixed-test` … 固定した試験で確かめる
 * - `structural` … 構造の条件（create の操作がある・一覧や表に項目が出る・画面の部品がある）で確かめる
 * - `unresolved` … いまは確かめられない（未解決のまま残す）
 *
 * `fixed-test` 以外は**理由を必須**にする（試験を作らないときは理由を必須にする）。
 */
export const REQUIREMENT_VERIFICATION_KINDS = ["fixed-test", "structural", "unresolved"] as const;
export type RequirementVerificationKind = (typeof REQUIREMENT_VERIFICATION_KINDS)[number];
export type RequirementVerification =
  | { readonly kind: "fixed-test" }
  | { readonly kind: "structural"; readonly reason: string }
  | { readonly kind: "unresolved"; readonly reason: string };

/**
 * 役割 ID の表の 1 行（② が固定する。§1・②・Issue #307）。
 *
 * 役割 ID は **entity の文脈を含む ID**（例 `member`・`member.name`・`session.bookCount`）。
 * **共有**（複数の要件が同じ entity を使う）と**別名**は、`shared`・`aliasOf` の欄でだけ許す。
 * 同名の別 entity は**別の役割 ID** にする（同じ役割 ID に潰さない）。
 */
export interface RoleEntry {
  /** 役割 ID（entity の文脈を含む ID） */
  readonly roleId: string;
  /** 対象の種類（entity・項目・計算・操作・画面の部品） */
  readonly kind: TestTargetKind;
  /** 所属の entity の役割 ID（entity 自身の行では null） */
  readonly entity: string | null;
  /** 対象の名前（役割 ID の中の呼び名。宣言の名前ではない） */
  readonly name: string;
  /** 共有を明示したか（複数の要件が同じ entity を使う） */
  readonly shared: boolean;
  /** 別名なら、元の役割 ID（別名でなければ null） */
  readonly aliasOf: string | null;
}

/** ② 設計する、で要件ごとに決める語彙と置き場所（役割 ID・種類・確かめ方は Issue #307 で足した） */
export interface RequirementDesign {
  readonly requirementId: string;
  /** 要件の種類（決まりを含む／在ることだけ）。② が固定する（Issue #307） */
  readonly nature?: RequirementNature;
  /** 確かめ方（固定した試験／構造の条件／未解決）。② が固定する（Issue #307） */
  readonly verification?: RequirementVerification;
  /** 使う語彙（無い語彙・キー・関数は作らない。F-5） */
  readonly vocabulary: readonly string[];
  /** 置き場所（宣言のどの欄か） */
  readonly placement: readonly string[];
  /** 書けない部分（書ける部分は残す。F-4） */
  readonly unwritable: readonly string[];
}

/** ② 設計する、の出力 */
export interface DesignResult {
  /** 役割 ID の表（② が固定する。Issue #307） */
  readonly roles?: readonly RoleEntry[];
  readonly designs: readonly RequirementDesign[];
}

/**
 * ③ が提出する「役割 ID → 宣言の名前」の対応の 1 行（§1・Issue #307。
 * 中身の点検は次の Issue。型だけをここに置く）。
 */
export interface RoleNameMapping {
  /** 役割 ID（② の役割 ID の表のもの） */
  readonly roleId: string;
  /** その役割 ID に対応する、宣言での名前 */
  readonly name: string;
}

/**
 * ②' の分類が② の設計と食い違った 1 件（§1・②'・Issue #307）。
 * 食い違った要件は**決まりを含むほうへ倒し**、そのことを結果に残す。
 */
export interface NatureDiscrepancy {
  readonly requirementId: string;
  /** ② の設計が決めた種類 */
  readonly design: RequirementNature;
  /** ②' が原文と要件の一覧から独立に分類した種類 */
  readonly classified: RequirementNature;
  /** 倒した先（食い違ったときは `ruled`） */
  readonly resolved: RequirementNature;
}

/**
 * ②' で固定する試験の型は fixed-test.ts が正本である（種類・selector（要件 ID と役割 ID）・操作・時計・
 * 参照データ・期待。02 §1.3・②'）。型だけの file なので、根（index.ts が `export *` するこの file）から
 * 読めるように、ここで再輸出する。②' の出力は `TestSuite` である。
 */
export type {
  FixedTest,
  ReferenceRow,
  RequirementClassification,
  RequirementNature,
  TestExpected,
  TestInputContract,
  TestKind,
  TestOperation,
  TestSuite,
  TestTarget,
  TestTargetKind,
} from "./fixed-test.js";

/**
 * ③ 書く、の出力＝宣言（YAML の原文）。静的チェックはまだ通っていない（§1）。
 * 大きさの上限（§1.5）は**書いた直後**に確かめるので、原文そのものを持つ。
 */
export interface Declaration {
  /** 宣言（app.spec.yaml）の原文。静的チェック（④）はこの原文を受け取る */
  readonly source: string;
}

/**
 * ④ 静的チェック、の出力（誤りコードと位置。Q-4）。
 * 誤りコードと位置は spec-engine の `normalizeSpec` が返したものを**そのまま**持つ（自分で足さない）。
 */
export interface StaticCheckResult {
  /** 静的チェックを通過したか（⑦ の入力になる。§1.4） */
  readonly passed: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** 通過した宣言（正規化した JSON）。通過しなければ `null`（⑤a 以降はこれを使う） */
  readonly app: NormalizedAppSpec | null;
}

/** 宣言の要素の種類（⑤a 対応表が挙げる「場所」の種類。§1・§1.3） */
export const DECLARATION_LOCATION_KINDS = [
  "entity",
  "field",
  "validation",
  "computation",
  "action",
  "view",
] as const;
export type DeclarationLocationKind = (typeof DECLARATION_LOCATION_KINDS)[number];

/**
 * 宣言の中の 1 つの場所（⑤a が挙げ、コードが実在と到達を確かめる。§1）。
 * `kind` が `entity` のときだけ `entity` は `null`（ほかは、その要素を載せている entity の名前）。
 */
export interface DeclarationLocation {
  readonly kind: DeclarationLocationKind;
  readonly entity: string | null;
  readonly name: string;
}

/** ⑤a 対応表：要件ごとに、満たす宣言の場所 */
export interface CorrespondenceEntry {
  readonly requirementId: string;
  readonly locations: readonly DeclarationLocation[];
}

/** 対応表の落ち（宣言に無い名前・画面から辿れない計算。§1）。⑦ の入力になる */
export interface CorrespondenceMiss {
  readonly requirementId: string;
  /** 落ちの原因になった場所。要件の対応そのものが無いときは省く */
  readonly location?: DeclarationLocation;
  readonly detail: string;
}

/** ⑤a 対応表、の出力（挙げた名前が実在し、画面から辿れるかはコードが確かめる） */
export interface CorrespondenceResult {
  readonly entries: readonly CorrespondenceEntry[];
  /** 対応表の落ち。落ちの数は `misses.length`（⑦ の `correspondenceMisses`） */
  readonly misses: readonly CorrespondenceMiss[];
}

/**
 * ⑤b 結び付け：1 件の試験の selector（要件 ID・種類・役割）を、対応表が挙げた場所を通して
 * 宣言の実在の要素 1 つに結び付けた結果（§1.3）。0 個・2 個以上なら `unbound`（理由つき）。
 */
export type TestBinding =
  | { readonly kind: "bound"; readonly testId: string; readonly location: DeclarationLocation }
  | { readonly kind: "unbound"; readonly testId: string; readonly detail: string };

/** 試験を流したときの不一致（期待と合わなかった・結び付けられなかった） */
export interface TestMismatch {
  readonly testId: string;
  readonly detail: string;
}

/** 試験を流せずに未解決として数えるもの（入力の型・操作の実行。§1.3・U-G） */
export interface TestUnresolved {
  readonly testId: string;
  readonly detail: string;
}

/**
 * ⑤b 試験を流した結果（結び付けられなかった試験は不一致として数える。F-9・R-8）。
 * `unresolved` は評価器で確かめられない試験で、⑦ では「未解決」として数える（合格にしない）。
 */
export interface TestRunResult {
  readonly mismatches: readonly TestMismatch[];
  readonly unresolved: readonly TestUnresolved[];
}

/**
 * 直す役が「この期待は誤り」と主張した 1 件（§1.3・R-2）。
 *
 * 主張には**原文の引用**を必ず添える。引用が原文に実在しなければ（捏造）、主張として受け付けない
 * ——受け付けなかった主張は `RejectedDispute` として残す（黙って落とさない）。
 */
export interface Dispute {
  /** 期待が誤りと主張する試験の識別子 */
  readonly testId: string;
  /** 主張の根拠にした、原文からそのまま写した引用 */
  readonly quote: string;
}

/** 受け付けなかった主張（引用が無い・原文に実在しない）。理由つきで残す（§1.3） */
export interface RejectedDispute {
  readonly testId: string;
  /** 主張が添えた引用（無ければ空文字） */
  readonly quote: string;
  readonly reason: string;
}

/** ⑥ 直す、の出力。直した宣言と、受け付けた／受け付けなかった主張（§1.3） */
export interface RepairResult {
  /** 直した宣言（YAML の原文） */
  readonly declaration: Declaration;
  /** 受け付けた主張（引用が原文に実在するものだけ。⑥' の裁定へ渡す） */
  readonly disputes: readonly Dispute[];
  /** 受け付けなかった主張（引用が無い・原文に実在しない・一覧に無い試験。捏造の記録） */
  readonly rejected: readonly RejectedDispute[];
}

/** 棄却された試験（期待が誤り）。理由と引用を記録し、その試験を外す（§1.3） */
export interface OverturnedTest {
  readonly testId: string;
  /** 棄却の理由 */
  readonly reason: string;
  /** 棄却の根拠にした、原文に実在する引用 */
  readonly quote: string;
}

/**
 * ⑥' 期待の裁定、の出力（§1.3・R-2）。原文の引用を根拠に、期待が誤りかを裁定する。
 * 3 つの結果に分ける——**維持**（期待は正しい。宣言を直す）・**棄却**（期待が誤り。試験を外す）・
 * **裁定不能**（未解決として残す）。
 */
export interface ArbitrationResult {
  /** 維持：期待は正しい（宣言を直す） */
  readonly upheld: readonly string[];
  /** 棄却：期待が誤り（理由と引用を記録して、その試験を外す） */
  readonly overturned: readonly OverturnedTest[];
  /** 裁定不能：未解決として残す（⑦ で合格にならない） */
  readonly unresolved: readonly string[];
  /**
   * 確定した仕様そのものと食い違う主張（§5・Issue #334）。**裁定せず Plan に戻す**——仕様を変えるには
   * Plan のやり直し（再確認）が要るので、⑥' では棄却も維持もしない。差し戻しは 1 回までである。
   */
  readonly returnToPlan?: readonly string[];
}

/**
 * ある版の宣言と、その版に対して流し直した ④⑤ の結果（§1・§4）。
 *
 * `declarationSha256` は**その版**のバイト列のものである。古い版の結果へ、新しい版の SHA-256 を
 * 付け替えない（検証の結果を、どの版を検証したかに結び付ける。§4・F-11）。
 */
export interface VersionChecks {
  readonly declaration: Declaration;
  /** この版の宣言（原文）の UTF-8 バイト列の SHA-256 */
  readonly declarationSha256: string;
  readonly staticCheck: StaticCheckResult;
  /** 静的チェックを通ったときだけ。通らなければ `null`（⑤a 以降は流さない） */
  readonly correspondence: CorrespondenceResult | null;
  readonly testRun: TestRunResult | null;
}

/**
 * ⑥ 直す、の往復の結果（⑥' の裁定と、直した後の流し直しを含む。§1・§1.3・§1.4・§4・§1.5）。
 *
 * **外側（往復の回数・打ち切り・合否）はコードが決める**。直す役は試験と要件の一覧を変えられない
 * ——ここへ返す `list` と `suite` は、渡されたものそのまま（棄却で外した分だけを除く）である。
 */
export interface RepairLoopResult {
  /** 最後に静的チェックを通った版と、その版の流し直しの結果（上限に触れたときの返り値。§1.5） */
  readonly final: VersionChecks;
  /** 版ごとの結果（古い版の結果に、新しい版の SHA-256 を付けない。§4） */
  readonly versions: readonly VersionChecks[];
  /** 直しの往復を使った回数 */
  readonly rounds: number;
  /** 直しの往復の上限に触れたか（⑦ の入力。§1.4・§1.5） */
  readonly limitReached: boolean;
  /** 直しで前に通っていたものが落ちた回帰（不一致として数える。§1） */
  readonly regressions: readonly TestMismatch[];
  /** 維持された試験（期待は正しい。§1.3） */
  readonly upheld: readonly string[];
  /** 棄却され外した試験（理由と引用つき。§1.3） */
  readonly overturned: readonly OverturnedTest[];
  /** 裁定できずに残った試験（未解決。§1.3） */
  readonly unresolved: readonly string[];
  /** 直しても変わらない要件の一覧（直す役は変えられない） */
  readonly list: RequirementList;
  /** 直しても変わらない固定した試験（棄却で外した分を除く） */
  readonly suite: TestSuite;
}

/** ⑦ 終わりの判定、の入力（段の結果。§1.4） */
export type JudgeInput = StageResults;

/** ⑦ 終わりの判定、の出力 */
export type JudgeResult = Outcome;

/** 前半（①' 逆照合・②' 試験）から持ち越した未達（§1.2・②'） */
export interface UnmetCarryOver {
  /** ①' のやり直しでも残った落ち（引用が実在しない・位置が合わない・覆われていない原文の文） */
  readonly reverseCheck: readonly string[];
  /** ②' のやり直しでも欠けたままの要件（正常・異常・境界の欠けなど） */
  readonly testSuite: readonly string[];
}

/** ⑦ の入力を作る材料（後半の段の結果と、前半から持ち越した未達） */
export interface JudgeMaterials {
  readonly staticCheckPassed: boolean;
  readonly correspondenceMisses: number;
  readonly testMismatches: number;
  readonly testUnresolved: number;
  readonly unwritableRequirements: number;
  /**
   * 書けないと申告された要件のうち、`accepted_unwritable`（了承して除いた部分）の内側だけの数
   * （§5・Issue #334）。**確定した仕様があるときだけ**入れる。了承済みの部分は合格（full）を妨げない。
   */
  readonly acceptedUnwritable?: number;
  readonly limitReached: boolean;
  readonly carriedOver: UnmetCarryOver;
}

/**
 * 後半の段の結果と、前半から持ち越した未達を、⑦ の入力（`StageResults`）に写す（§1.4・②'）。
 *
 * **前半から持ち越した未達は、そのまま「未解決」に数える**——①' の落ちも ②' の欠けも、残っている限り
 * 合格の条件を満たさない（`unwritableRequirements` と同じく、部分案の側へ倒す）。
 */
export function toStageResults(materials: JudgeMaterials): StageResults {
  const carried = materials.carriedOver.reverseCheck.length + materials.carriedOver.testSuite.length;
  return {
    staticCheckPassed: materials.staticCheckPassed,
    correspondenceMisses: materials.correspondenceMisses,
    testMismatches: materials.testMismatches,
    unresolved: carried + materials.testUnresolved,
    unwritableRequirements: materials.unwritableRequirements,
    ...(materials.acceptedUnwritable === undefined
      ? {}
      : { acceptedUnwritable: materials.acceptedUnwritable }),
    limitReached: materials.limitReached,
  };
}

/** ⑧ 納品物にする、の出力（CommandAgent と同じ形。§4） */
export interface DeliveryBundle {
  /** bundle の manifest（`files` の SHA-256・大きさ） */
  readonly manifest: unknown;
  /** 要約（`status`・`verdict`・`assurance`・`artifact_level` など） */
  readonly summary: unknown;
  /** ⑦ の合否 */
  readonly outcome: Outcome;
  /** 検証の結果を結び付ける、完成した宣言のバイト列の SHA-256（§4・F-11） */
  readonly declarationSha256: string;
}
