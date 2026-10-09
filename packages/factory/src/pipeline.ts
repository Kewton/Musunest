// 段（パイプライン）の型だけを置く（02-architecture.md §1・§1.4）。中身は次の Issue。
//
// 外側（段の順番・記録・打ち切り・合否）はコードが決め、内側の「書く・直す」段だけを LLM に任せる。
// ここは ① 要件にする 〜 ⑧ 納品物にする の**入力と出力の型**だけを持つ。実装は持たない。
import type { AppSpec } from "@musunest/appspec-schema";
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

/** ③ 書く、の出力＝宣言。静的チェックはまだ通っていない */
export interface Declaration {
  readonly spec: AppSpec;
}

/** ④ 静的チェック、の出力（誤りコードと位置。Q-4） */
export interface StaticCheckResult {
  readonly diagnostics: readonly Diagnostic[];
}

/** ⑤a 対応表：要件ごとに、満たす宣言の場所 */
export interface CorrespondenceEntry {
  readonly requirementId: string;
  readonly locations: readonly string[];
}

/** ⑤a 対応表、の出力（挙げた名前が実在し、画面から辿れるかはコードが確かめる） */
export interface CorrespondenceResult {
  readonly entries: readonly CorrespondenceEntry[];
  /** 対応表の落ちの数（⑦ の入力になる） */
  readonly misses: number;
}

/** ⑤b 試験を流した結果（結び付けられなかった試験は不一致として数える） */
export interface TestRunResult {
  readonly mismatches: readonly string[];
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
