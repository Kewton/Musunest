// 段（パイプライン）の型（02-architecture.md §1・§1.4）。
//
// 外側（段の順番・記録・打ち切り・合否）はコードが決め、内側の「書く・直す」段だけを LLM に任せる。
// ここは ① 要件にする 〜 ⑧ 納品物にする の**入力と出力の型**と、前半（①'・②'）から持ち越した未達を
// ⑦ の入力へ写す**純粋な関数**を置く。段の中身（プロンプト・道具）は stages/ にある。
import type { NormalizedAppSpec } from "@musunest/appspec-schema";
import type { Diagnostic } from "@musunest/spec-engine";
import type { Outcome, StageResults } from "./outcome.js";

/** 原文の中の文字の範囲（① で付ける引用の位置） */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** 1 行 1 要件。原文の引用と位置を付ける（①。F-3） */
export interface Requirement {
  readonly id: string;
  readonly text: string;
  readonly quote: string;
  readonly position: SourceRange;
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

/** ② 設計する、で要件ごとに決める語彙と置き場所 */
export interface RequirementDesign {
  readonly requirementId: string;
  /** 使う語彙（無い語彙・キー・関数は作らない。F-5） */
  readonly vocabulary: readonly string[];
  /** 置き場所（宣言のどの欄か） */
  readonly placement: readonly string[];
  /** 書けない部分（書ける部分は残す。F-4） */
  readonly unwritable: readonly string[];
}

/** ② 設計する、の出力 */
export interface DesignResult {
  readonly designs: readonly RequirementDesign[];
}

// ②' で固定する試験の型は fixed-test.ts が正本である（種類・selector（要件 ID と役割）・操作・時計・
// 参照データ・期待。02 §1.3・②'）。型だけの file なので、根（index.ts が `export *` するこの file）から
// 読めるように、ここで再輸出する。②' の出力は `TestSuite` である。
export type { FixedTest, ReferenceRow, TestExpected, TestKind, TestOperation, TestSuite, TestTarget, TestTargetKind } from "./fixed-test.js";

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

/** ⑥ 直す、の出力 */
export interface RepairResult {
  readonly declaration: Declaration;
  /** 直す役が「この期待は誤り」と主張した試験（原文の引用つき。F-9・②'） */
  readonly disputedTests: readonly string[];
}

/** ⑥' 期待の裁定、の出力（原文の引用を根拠に、期待が誤りかを裁定する） */
export interface ArbitrationResult {
  /** 誤りと裁定された試験 */
  readonly overturned: readonly string[];
  /** 裁定できずに残った試験（⑦ で合格にならない） */
  readonly unresolved: readonly string[];
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
