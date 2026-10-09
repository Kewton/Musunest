// ⑥ 直す、の道具（02-architecture.md §1・§2.2）。
//
// 直す役に渡す道具は 3 つ——**静的チェック**（④）・**試験の実行**（⑤b）・**対応表の確認**（⑤a のコード）。
// いずれも**このリポジトリにある本物の検査**を呼ぶ（LLM の自己申告で合否を決めない。§1）。道具は
// 「宣言を 1 つ試す」形にそろえてある——直す役は直した候補を道具に渡し、コードの判定を受け取る。
//
// 引数は**コードが形と値を確かめる**（§2.2）。宣言の大きさ（§1.5）と道具の呼び出しの回数（§1.5）の
// 上限もここで当てる——形の合わない引数・上限を超える宣言・上限を超える回数は、呼ぶ前に断る。
//
// 往復の型（`LlmToolDefinition`・`LlmToolRequest`・`LlmToolResponse`）は llm.ts が正本である。ここは
// 「どの道具があり、引数をどう確かめ、何を返すか」だけを置く。往復の組み立ては repair.ts が行う。
import type { Diagnostic } from "@musunest/spec-engine";
import { checkDeclarationBytes, checkLimit, type LimitExceeded } from "../limits.js";
import type { LlmToolDefinition } from "../llm.js";
import type {
  CorrespondenceEntry,
  CorrespondenceMiss,
  Declaration,
  RequirementList,
  TestMismatch,
  TestSuite,
  TestUnresolved,
} from "../pipeline.js";
import { checkCorrespondence } from "./correspondence.js";
import { isRecord, type Problem } from "./prompt.js";
import { runTests } from "./run-tests.js";
import { runStaticCheck } from "./static-check.js";
import { utf8ByteLength } from "./write.js";

/** 直す段の道具の名前（§1） */
export const REPAIR_TOOL_NAMES = ["static-check", "run-tests", "check-correspondence"] as const;
export type RepairToolName = (typeof REPAIR_TOOL_NAMES)[number];

/** 道具の名前か */
export function isRepairToolName(value: string): value is RepairToolName {
  return (REPAIR_TOOL_NAMES as readonly string[]).includes(value);
}

/** 3 つの道具に共通の引数の JSON Schema（宣言を 1 つ受け取る） */
const DECLARATION_ARGUMENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["declaration"],
  properties: {
    declaration: { type: "string", description: "試す宣言（app.spec.yaml の原文）" },
  },
} as const;

/** 直す役に渡す道具の定義（§1・§2.2）。名前・説明・引数の JSON Schema を持つ */
export const REPAIR_TOOLS: readonly LlmToolDefinition[] = [
  {
    name: "static-check",
    description: "宣言を静的チェック（④）に通し、通ったかと誤りコード・位置の一覧を返す。",
    parameters: DECLARATION_ARGUMENTS_SCHEMA,
  },
  {
    name: "run-tests",
    description:
      "宣言を静的チェックに通してから、固定した試験（⑤b）を流し、不一致と未解決を返す。静的チェックに通らなければ流さない。",
    parameters: DECLARATION_ARGUMENTS_SCHEMA,
  },
  {
    name: "check-correspondence",
    description:
      "宣言を静的チェックに通してから、対応表（⑤a）が挙げた場所が実在するかを確かめ、落ちを返す。静的チェックに通らなければ確かめない。",
    parameters: DECLARATION_ARGUMENTS_SCHEMA,
  },
];

/** 引数を確かめて得た、実行してよい道具の呼び出し */
export interface ValidToolCall {
  readonly name: RepairToolName;
  readonly declaration: Declaration;
}

/** 道具の呼び出しの引数を確かめた結果 */
export type ToolCallCheck =
  | { readonly ok: true; readonly call: ValidToolCall }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/**
 * 道具の呼び出しの引数を確かめる（§2.2）。**形と値の両方**を見る：
 *   - 名前が 3 つの道具のいずれかであること
 *   - 引数が写像で、`declaration` が空でない文字列であること
 *   - 宣言の大きさが上限（§1.5）に収まっていること
 * 合わない欄を**すべて**挙げて返す（1 つ直すたびにやり直させない）。呼ぶ前に断る。
 */
export function checkToolArguments(name: string, args: unknown): ToolCallCheck {
  if (!isRepairToolName(name)) {
    return { ok: false, problems: [{ field: "name", message: `道具 ${name} は無い` }] };
  }
  if (!isRecord(args)) {
    return { ok: false, problems: [{ field: "arguments", message: "引数は写像（object）であること" }] };
  }
  const declaration = args["declaration"];
  if (typeof declaration !== "string" || declaration === "") {
    return {
      ok: false,
      problems: [{ field: "arguments.declaration", message: "宣言は空でない文字列（YAML の原文）であること" }],
    };
  }
  const exceeded = checkDeclarationBytes(utf8ByteLength(declaration));
  if (exceeded !== undefined) {
    return {
      ok: false,
      problems: [
        {
          field: "arguments.declaration",
          message: `宣言が上限 ${exceeded.max} バイトを超えている（${exceeded.actual}）`,
        },
      ],
    };
  }
  return { ok: true, call: { name, declaration: { source: declaration } } };
}

/**
 * 道具の呼び出しの回数の上限を確かめる（§1.5）。すでに `used` 回呼んでいて、いま `requested` 回呼ぶ。
 * 合計が上限を超えれば `LimitExceeded` を返す（呼ぶ前に断る）。
 */
export function checkToolCallBudget(used: number, requested: number): LimitExceeded | undefined {
  return checkLimit("toolCalls", used + requested);
}

/** 道具が触る、直しても変わらない文脈（要件の一覧・固定した試験・対応表の場所。§1.3） */
export interface RepairToolContext {
  readonly list: RequirementList;
  readonly suite: TestSuite;
  readonly correspondences: readonly CorrespondenceEntry[];
}

/** 静的チェックの道具の出力 */
export interface StaticCheckToolOutput {
  readonly passed: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/** 試験の実行・対応表の確認の道具の出力（静的チェックを通らないときは空で `detail` に理由） */
export interface RepairToolOutput {
  readonly passed: boolean;
  readonly detail: string;
  readonly mismatches: readonly TestMismatch[];
  readonly unresolved: readonly TestUnresolved[];
  readonly misses: readonly CorrespondenceMiss[];
}

/** 静的チェックを通らない宣言は、⑤b・⑤a へ渡さない（成果物を返さない。§1・Q12） */
const staticCheckFailed: RepairToolOutput = {
  passed: false,
  detail: "静的チェックを通らない",
  mismatches: [],
  unresolved: [],
  misses: [],
};

/**
 * 確かめた道具の呼び出しを実行し、応答へ返す値を得る（§1）。
 * 静的チェックを通らない宣言では、試験の実行と対応表の確認は流さず、その旨を返す。
 */
export async function executeRepairTool(
  call: ValidToolCall,
  context: RepairToolContext,
): Promise<StaticCheckToolOutput | RepairToolOutput> {
  const checked = await runStaticCheck(call.declaration);
  if (call.name === "static-check") {
    return { passed: checked.passed, diagnostics: checked.diagnostics };
  }
  if (!checked.passed || checked.app === null) return staticCheckFailed;

  if (call.name === "run-tests") {
    const result = runTests({
      app: checked.app,
      suite: context.suite,
      correspondence: { entries: context.correspondences, misses: [] },
    });
    return {
      passed: result.mismatches.length === 0 && result.unresolved.length === 0,
      detail: "",
      mismatches: result.mismatches,
      unresolved: result.unresolved,
      misses: [],
    };
  }

  const misses = checkCorrespondence(checked.app, context.list, context.correspondences);
  return { passed: misses.length === 0, detail: "", mismatches: [], unresolved: [], misses };
}
