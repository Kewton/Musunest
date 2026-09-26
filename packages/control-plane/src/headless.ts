// 工場（CommandAgent）の headless 契約 v1 の読み取りと、受け入れの判定（Issue #246）。
//
// 工場は `--summary-json` で、**stdout の最終行**に `commandagent.headless-summary/v1` の JSON を 1 行で出す
// （ピン `pins/commandagent.json` の revision 031ec74。`headless_contract`）。その前の行は人向けの出力である。
// ここは、その最後の JSON の行を読んで v1 の欄を型つきで返し、Q7（`workspace/mvp/m1/00-open-questions.md` §Q7・
// 2026-09-26 所有者）の規則で受け入れを判定する。
//
// **読むだけである。** パスの欄（`artifacts_dir`・`acceptance_sheet_path`・`events_path`）は読むだけで、
// ファイルには触らない。**依存の向きを足さない**（純粋な TypeScript。CLAUDE.md「依存の向き」・Q20 が
// 置き場所を control-plane に決めた理由）。
//
// Q7 の規則（窓口の決定。2026-09-26）：
//   - 終了コードだけで合否を決めない（0 は「プロセスが完了した」だけを意味する）
//   - `status` が `completed` でなければ受け入れない
//   - L2（宣言だけの納品物）：`verdict` が `full`、かつ `assurance` が `full` か `partial`
//   - L3/L4：`verdict` と `assurance` がどちらも `full`
//   - 受け入れない理由（どの欄が何だったか）を返す
//
// ピン（031ec74）の互換メモ（`headless_contract.$compatibility`）：
//   - **既存のスカラーのキーは常に存在し、欠測は JSON null で埋まる。** だから、スカラーのキーが
//     無い要約は v1 として断る
//   - `provider_usage_by_role`（provider turn が無ければ空）と `pack`（pack 未選択なら省略）は
//     additive な追加である。`pack` だけは無いことがある

/** `--summary-json` が最終 stdout 行に出す JSON の `schema_version`（ピン 031ec74 の `headless_contract.version`）。 */
export const HEADLESS_SCHEMA_VERSION = "commandagent.headless-summary/v1" as const;
export type HeadlessSchemaVersion = typeof HEADLESS_SCHEMA_VERSION;

/** スカラーのキーと、並びの欄（`pack` を除く、v1 で必ず存在する欄）。ピン 031ec74 の `$compatibility`。 */
export const HEADLESS_REQUIRED_KEYS = [
  "run_id",
  "verdict",
  "assurance",
  "score",
  "acceptance_sheet_path",
  "artifacts_dir",
  "events_path",
  "duration_secs",
  "provider_cost_usd",
  "provider_usage_by_role",
  "stop_class",
  "directive_round",
  "status",
  "gate",
  "stop_reason",
  "next_action",
  "changed_files",
  "verify_commands",
  "exit_code",
] as const;

/** 無いことがある欄（`pack` 未選択なら省略される。additive な追加）。 */
export const HEADLESS_OPTIONAL_KEYS = ["pack"] as const;

/**
 * v1 の要約。キーは契約の snake_case を、このリポジトリの TypeScript の作法（camelCase）に写す。
 * **無い値は `null`**（契約がそう埋める）。`pack` だけは、無いとき `null`。
 *
 * 並びの欄（`provider_usage_by_role`・`changed_files`・`verify_commands`・`pack`）の**要素の形は、
 * このピンと Issue の本文が決めていない**ので、ここでは中身を縛らない（情報を落とさない）。
 */
export interface HeadlessSummary {
  readonly schemaVersion: HeadlessSchemaVersion;
  readonly runId: string | null;
  readonly verdict: string | null;
  readonly assurance: string | null;
  readonly score: number | null;
  readonly acceptanceSheetPath: string | null;
  readonly artifactsDir: string | null;
  readonly eventsPath: string | null;
  readonly durationSecs: number | null;
  readonly providerCostUsd: number | null;
  readonly providerUsageByRole: Readonly<Record<string, unknown>>;
  readonly stopClass: string | null;
  readonly directiveRound: number | null;
  readonly status: string | null;
  readonly gate: string | null;
  readonly stopReason: string | null;
  readonly nextAction: string | null;
  readonly changedFiles: readonly unknown[];
  readonly verifyCommands: readonly unknown[];
  readonly exitCode: number | null;
  readonly pack: Readonly<Record<string, unknown>> | null;
}

// ── 読み取り ──────────────────────────────────────────────────────

/** 読み取りを断る理由。 */
export const HEADLESS_READ_FAILURE_CODES = [
  "summary_not_found",
  "schema_version_mismatch",
  "missing_keys",
] as const;
export type HeadlessReadFailureCode = (typeof HEADLESS_READ_FAILURE_CODES)[number];

/** 読み取りの失敗。呼ぶ側が例外の文言に依存しないよう、原因はコードで分ける。 */
export interface HeadlessReadFailure {
  readonly ok: false;
  readonly code: HeadlessReadFailureCode;
  /** 人が読む説明。**資格情報・ホストのパスを含めない** */
  readonly message: string;
  /** `missing_keys` のときだけ、欠けているキー。それ以外は空 */
  readonly missingKeys: readonly string[];
  /** `schema_version_mismatch` のときだけ、実際の値。それ以外は `null`（文字列でなければ `null`） */
  readonly actualSchemaVersion: string | null;
}

export interface HeadlessReadSuccess {
  readonly ok: true;
  readonly summary: HeadlessSummary;
}

export type HeadlessReadResult = HeadlessReadSuccess | HeadlessReadFailure;

const READ_FAILURE_MESSAGES = {
  summary_not_found: "stdout に v1 の要約の JSON の行が無い（最終行の JSON を読む。前の行は人向けの出力）",
  schema_version_mismatch: "schema_version が commandagent.headless-summary/v1 ではない（v1 ではない要約は受け取らない）",
  missing_keys: "スカラーのキーが欠けている（v1 のキーは常にあり、無い値は null で埋まる）",
} as const satisfies Record<HeadlessReadFailureCode, string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const readRecord = (value: unknown): Readonly<Record<string, unknown>> => (isRecord(value) ? value : {});
const readArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/**
 * stdout の全文から、**最後の JSON の行**を取り出す。最終行から前へ見て、`{` で始まり JSON の写像として
 * 読める最初の行を返す（前の行は人向けの出力なので、読めない行は飛ばす）。見つからなければ `null`。
 */
function lastJsonObjectLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) return value;
    } catch {
      // JSON として読めない行は人向けの出力。前の行を見る
    }
  }
  return null;
}

const toSummary = (record: Record<string, unknown>): HeadlessSummary => {
  const pack = record["pack"];
  return {
    schemaVersion: HEADLESS_SCHEMA_VERSION,
    runId: readString(record["run_id"]),
    verdict: readString(record["verdict"]),
    assurance: readString(record["assurance"]),
    score: readNumber(record["score"]),
    acceptanceSheetPath: readString(record["acceptance_sheet_path"]),
    artifactsDir: readString(record["artifacts_dir"]),
    eventsPath: readString(record["events_path"]),
    durationSecs: readNumber(record["duration_secs"]),
    providerCostUsd: readNumber(record["provider_cost_usd"]),
    providerUsageByRole: readRecord(record["provider_usage_by_role"]),
    stopClass: readString(record["stop_class"]),
    directiveRound: readNumber(record["directive_round"]),
    status: readString(record["status"]),
    gate: readString(record["gate"]),
    stopReason: readString(record["stop_reason"]),
    nextAction: readString(record["next_action"]),
    changedFiles: readArray(record["changed_files"]),
    verifyCommands: readArray(record["verify_commands"]),
    exitCode: readNumber(record["exit_code"]),
    pack: pack === undefined || pack === null ? null : readRecord(pack),
  };
};

const readFailure = (
  code: HeadlessReadFailureCode,
  fields: {
    readonly missingKeys?: readonly string[];
    readonly actualSchemaVersion?: string | null;
  } = {},
): HeadlessReadFailure => ({
  ok: false,
  code,
  message: READ_FAILURE_MESSAGES[code],
  missingKeys: fields.missingKeys ?? [],
  actualSchemaVersion: fields.actualSchemaVersion ?? null,
});

/**
 * stdout の全文から、最後の JSON の行（v1 の要約）を読む。**例外を外へ出さない**（失敗は結果にする）。
 *
 * 断る条件：
 *   - 最後の JSON の行が無い（人向けの出力しか無い・空）
 *   - `schema_version` が `commandagent.headless-summary/v1` でない（版が違う）
 *   - スカラーのキー（`pack` 以外）が欠けている
 */
export function readHeadlessSummary(stdout: string): HeadlessReadResult {
  const record = lastJsonObjectLine(stdout);
  if (record === null) return readFailure("summary_not_found");

  const version = record["schema_version"];
  if (version !== HEADLESS_SCHEMA_VERSION) {
    return readFailure("schema_version_mismatch", { actualSchemaVersion: readString(version) });
  }

  const missingKeys = HEADLESS_REQUIRED_KEYS.filter((key) => !(key in record));
  if (missingKeys.length > 0) return readFailure("missing_keys", { missingKeys });

  return { ok: true, summary: toSummary(record) };
}

// ── 受け入れの判定（Q7）────────────────────────────────────────────

/** 納品物の水準。L2 は宣言だけ、L3/L4 はコードを含む（`workspace/mvp/m1/README.md` §3.2・§5）。 */
export const DELIVERY_LEVELS = ["L2", "L3", "L4"] as const;
export type DeliveryLevel = (typeof DELIVERY_LEVELS)[number];

/** `status` が完了を表す値。 */
export const STATUS_COMPLETED = "completed" as const;
/** `verdict` が合格を表す値（L2・L3/L4 とも必須）。 */
export const VERDICT_FULL = "full" as const;
/** `assurance` が全幅を表す値。 */
export const ASSURANCE_FULL = "full" as const;
/** `assurance` が部分を表す値（L2 だけ受け入れる）。 */
export const ASSURANCE_PARTIAL = "partial" as const;

/** 受け入れない理由のコード。 */
export const ACCEPTANCE_REASON_CODES = [
  "status_not_completed",
  "verdict_not_full",
  "assurance_insufficient",
] as const;
export type AcceptanceReasonCode = (typeof ACCEPTANCE_REASON_CODES)[number];

/** 受け入れない理由。**どの欄が何だったか**（`field`・`actual`）と、要る値（`expected`）を持つ。 */
export interface AcceptanceReason {
  readonly code: AcceptanceReasonCode;
  readonly field: "status" | "verdict" | "assurance";
  /** 要約の実際の値（無ければ `null`） */
  readonly actual: string | null;
  /** 受け入れに要る値 */
  readonly expected: readonly string[];
}

export interface AcceptanceDecision {
  readonly accepted: boolean;
  readonly level: DeliveryLevel;
  /** 受け入れない理由。**受け入れるときは空** */
  readonly reasons: readonly AcceptanceReason[];
}

/** 水準ごとに受け入れる `assurance`。L2 は `partial` 以上、L3/L4 は `full` だけ（Q7）。 */
const acceptedAssurance = (level: DeliveryLevel): readonly string[] =>
  level === "L2" ? [ASSURANCE_FULL, ASSURANCE_PARTIAL] : [ASSURANCE_FULL];

/**
 * Q7 の規則で受け入れを判定する。**終了コードは見ない**（`exit_code: 0` は「プロセスが完了した」だけ）。
 *
 * 受け入れない理由は、満たさない欄ごとに集める（`status` → `verdict` → `assurance` の順）。
 */
export function judgeAcceptance(summary: HeadlessSummary, level: DeliveryLevel): AcceptanceDecision {
  const reasons: AcceptanceReason[] = [];

  if (summary.status !== STATUS_COMPLETED) {
    reasons.push({
      code: "status_not_completed",
      field: "status",
      actual: summary.status,
      expected: [STATUS_COMPLETED],
    });
  }

  if (summary.verdict !== VERDICT_FULL) {
    reasons.push({ code: "verdict_not_full", field: "verdict", actual: summary.verdict, expected: [VERDICT_FULL] });
  }

  const expectedAssurance = acceptedAssurance(level);
  if (summary.assurance === null || !expectedAssurance.includes(summary.assurance)) {
    reasons.push({
      code: "assurance_insufficient",
      field: "assurance",
      actual: summary.assurance,
      expected: expectedAssurance,
    });
  }

  return { accepted: reasons.length === 0, level, reasons };
}
