// 納品物（工場が 2 つとも使う、bundle の manifest と headless の要約）の wire の正本（Issue #283）。
//
// 設計の正本は `workspace/mvp/m1/agent/02-architecture.md` §3.1・§4（R-11）。工場（CommandAgent と、
// プロダクト内の factory）は control-plane に依存しないので、納品物の形はここに 1 つだけ置く。
//
// **wire の形（JSON の欄の名前のまま。snake_case）と、読み取った結果（camelCase）を分けて置く**（R-8）。
// **読み取り（stdout の最後の JSON の行を読むこと）は control-plane に残す**（§3.1 の「読み取りの adapter」）。
// ここは wire の schema（受け付ける形）・型・版を持つ。
//
// 欄の意味は変えない（`instrument.binary_sha256` に何を入れるかなど、プロダクト内の工場での読み方は
// 別の Issue で互換を決める。版の名前も変えない）。
//
// ここは依存を持たない純粋な TypeScript である。Cloudflare 固有の API も Node 固有の API も使わない。

// ── manifest（`commandagent.community-delivery-bundle/v1`）の wire ──

/** 対応する manifest の版。`schema_version` がこれと違えば断る。 */
export const BUNDLE_MANIFEST_SCHEMA_VERSION = "commandagent.community-delivery-bundle/v1" as const;

/** `files` の 1 項目。納品物の直下からの相対パス（`/` 区切り）と、大きさ・SHA-256。 */
export interface BundleManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

/** manifest が指す検証の道具（offline verifier のバイナリと、使った profile）。 */
export interface BundleManifestInstrument {
  readonly binary_sha256: string;
  readonly verification_profile: string;
}

/** 納品物の manifest（v1）の wire。欄の名前は契約の snake_case のまま。 */
export interface BundleManifest {
  readonly schema_version: string;
  readonly storage_unit: string;
  readonly source_run: string;
  readonly artifact_level: string;
  readonly expected_verdict: string;
  readonly instrument: BundleManifestInstrument;
  readonly files: readonly BundleManifestFile[];
}

// ── 要約（`commandagent.headless-summary/v1`）の wire ──────────────

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
 * v1 の要約の **wire**。キーは契約の snake_case のまま。**無い値は JSON の `null`**（契約がそう埋める）。
 * `pack` だけは、無いとき省略される（または `null`）。
 *
 * 並びの欄（`provider_usage_by_role`・`changed_files`・`verify_commands`・`pack`）の**要素の形は、
 * ピンと Issue の本文が決めていない**ので、ここでは中身を縛らない（情報を落とさない）。
 */
export interface HeadlessSummaryWire {
  readonly schema_version: string;
  readonly run_id: string | null;
  readonly verdict: string | null;
  readonly assurance: string | null;
  readonly score: number | null;
  readonly acceptance_sheet_path: string | null;
  readonly artifacts_dir: string | null;
  readonly events_path: string | null;
  readonly duration_secs: number | null;
  readonly provider_cost_usd: number | null;
  readonly provider_usage_by_role: Readonly<Record<string, unknown>>;
  readonly stop_class: string | null;
  readonly directive_round: number | null;
  readonly status: string | null;
  readonly gate: string | null;
  readonly stop_reason: string | null;
  readonly next_action: string | null;
  readonly changed_files: readonly unknown[];
  readonly verify_commands: readonly unknown[];
  readonly exit_code: number | null;
  readonly pack?: Readonly<Record<string, unknown>> | null;
}

// ── 読み取った結果（camelCase）────────────────────────────────────

/**
 * v1 の要約の読み取り結果。キーは契約の snake_case を、このリポジトリの TypeScript の作法（camelCase）に写す。
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

// ── wire の schema（受け付ける形）─────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 要約の wire（`commandagent.headless-summary/v1`）が受け付けられるかの判定。**読み取りはしない**
 * （読み取りは control-plane の `readHeadlessSummary`。§3.1）。
 *
 * control-plane の読み取りと同じ幅を受け付ける。**判定を厳しくしない**：
 *   - 必須の欄（`HEADLESS_REQUIRED_KEYS`）がそろっていること。**値は縛らない**——欠測の `null` も、
 *     知らない値の文字列も受け付ける
 *   - `pack`（`HEADLESS_OPTIONAL_KEYS`）は無くてよい
 *   - **知らない欄が足されていても受け付ける**（読み取りは読み飛ばす）
 *   - `schema_version` が v1 であること
 */
export function acceptsHeadlessSummaryWire(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["schema_version"] !== HEADLESS_SCHEMA_VERSION) return false;
  return HEADLESS_REQUIRED_KEYS.every((key) => key in value);
}
