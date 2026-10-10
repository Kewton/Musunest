// 納品物から宣言を取り出し、4 つの門を通してから publish する部品の受入試験（Issue #248）。
//
// **工場の実物のファイルは使わない。** テストの中で作った小さな納品物（一時ディレクトリ）と、
// 手で書いた headless の出力・pins の写しで確かめる。
//   1. manifest の照合・pins の比較・受け入れの判定・静的チェックの**どれかが落ちると publish しない**
//      （R2 にも D1 にも書かない。受入条件 1）
//   2. 4 つとも通ると、既存の publish の中身へ**読み取った宣言のまま**渡す（書き込みは偽の口で。受入条件 2）
//   3. どの見本にも pins の値が入っていなければ、比較を飛ばして通す（値が null のとき）
//
// node:fs・node:os・node:path は Node 組み込みで、src の tsconfig の types は workers-types だけなので、
// 使う形だけを書いて**動的**に読む（bundle.test.ts と同じやり方）。
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_SPEC_SCHEMA_VERSION, planDigest } from "@musunest/appspec-schema";
import { HEADLESS_SCHEMA_VERSION } from "./headless.js";
import {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_PLAN_SHA256_FIELD,
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  type BundleManifestFile,
} from "./bundle.js";
import {
  BundlePinError,
  BUNDLE_DECLARATION_PATH,
  BUNDLE_PLAN_PATH,
  BUNDLE_VERIFICATION_PATH,
  PLAN_SHA256_FIELD,
  compareBundleManifestToPins,
  publishBundle,
  type BundlePublishResult,
  type DeliveryBundleSample,
} from "./bundle-publish.js";
import type { RegistryExecutor, SqlResult, SqlRow, SqlStatement } from "./contract.js";
import type { SpecWriter } from "./publish.js";

// ── Node 組み込みの最小の形 ──────────────────────────────────────

interface FsModule {
  mkdtempSync(prefix: string): string;
  mkdirSync(path: string, options: { readonly recursive: true }): void;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { readonly recursive: true; readonly force: true }): void;
}
interface OsModule {
  tmpdir(): string;
}
interface PathModule {
  join(...parts: readonly string[]): string;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const [{ mkdtempSync, mkdirSync, writeFileSync, rmSync }, { tmpdir }, { join }] = (await Promise.all([
  importUntyped("node:fs"),
  importUntyped("node:os"),
  importUntyped("node:path"),
])) as [FsModule, OsModule, PathModule];

const encoder = new TextEncoder();
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

// ── 検査を通る、最小の宣言（spec-engine・publish.test.ts と同じ形）──

const DECLARATION = [
  "entities:",
  "  - name: expense",
  "    fields:",
  "      amount: number",
  "      participants: list",
  "views: []",
  "actions: []",
  "validations:",
  "  - name: positiveAmount",
  "    entity: expense",
  "    expression: amount > 0",
  "computed:",
  "  - name: headcount",
  "    entity: expense",
  "    expression: len(participants)",
  "    type: number",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");

// ── 手で書いた headless v1 の要約（L2 が受け入る値）──────────────

const summaryLine = (overrides: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    schema_version: HEADLESS_SCHEMA_VERSION,
    run_id: "run-2026-09-26-001",
    verdict: "full",
    assurance: "partial",
    score: 0.98,
    acceptance_sheet_path: "acceptance/sheet.json",
    artifacts_dir: "artifacts",
    events_path: "events.jsonl",
    duration_secs: 12.5,
    provider_cost_usd: 0.42,
    provider_usage_by_role: { builder: { turns: 3 } },
    stop_class: "completed",
    directive_round: 1,
    status: "completed",
    gate: "S",
    stop_reason: null,
    next_action: null,
    changed_files: [BUNDLE_DECLARATION_PATH],
    verify_commands: ["pnpm test"],
    exit_code: 0,
    ...overrides,
  })}\n`;

// ── 一時ディレクトリに小さな納品物を作る道具 ──────────────────────

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const newBundleRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "musunest-bundle-publish-"));
  roots.push(root);
  return root;
};

function writeBundleFile(root: string, relative: string, content: string): void {
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), content);
}

async function writeEntry(root: string, relative: string, content: string): Promise<BundleManifestFile> {
  const bytes = encoder.encode(content);
  writeBundleFile(root, relative, content);
  return { path: relative, sha256: await sha256Hex(bytes), size_bytes: bytes.byteLength };
}

function writeManifest(
  root: string,
  files: readonly BundleManifestFile[],
  artifactLevel = "L2",
  planSha256: string | null = null,
): string {
  const manifest: Record<string, unknown> = {
    schema_version: BUNDLE_MANIFEST_SCHEMA_VERSION,
    storage_unit: "R2_delivery_unit",
    source_run: "e_test_001",
    artifact_level: artifactLevel,
    expected_verdict: "full",
    instrument: { binary_sha256: "b".repeat(64), verification_profile: "community-mini-app" },
    files,
  };
  if (planSha256 !== null) manifest[BUNDLE_MANIFEST_PLAN_SHA256_FIELD] = planSha256;
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(root, BUNDLE_MANIFEST_FILE), text);
  return text;
}

/** 小さな納品物を作り、manifest 自身の SHA-256 を返す。`tamper` は manifest の後に書き換えるパス。 */
async function makeBundle(
  options: { readonly declaration?: string; readonly artifactLevel?: string; readonly omitDeclaration?: boolean; readonly tamper?: string } = {},
): Promise<{ readonly root: string; readonly manifestSha256: string }> {
  const root = newBundleRoot();
  const files: BundleManifestFile[] = [];
  if (options.omitDeclaration !== true) {
    files.push(await writeEntry(root, BUNDLE_DECLARATION_PATH, options.declaration ?? DECLARATION));
  }
  const text = writeManifest(root, files, options.artifactLevel ?? "L2");
  if (options.tamper !== undefined) writeBundleFile(root, options.tamper, "tampered\n");
  return { root, manifestSha256: await sha256Hex(encoder.encode(text)) };
}

// ── 確定した仕様（plan.json）を作る道具（Issue #335）──────────────

/** #331 の検査に通る、最小の確定した仕様（`plan.json` の中身）。`confirmation.sha256` は外から入れる。 */
function basePlan(): Record<string, unknown> {
  return {
    schema_version: PLAN_SPEC_SCHEMA_VERSION,
    plan_id: "plan-1",
    revision: 1,
    vocabulary_version: "vocab-1",
    inputs: [{ id: "in-source-1", kind: "source", text: "原文の文の範囲" }],
    requirements: [
      {
        id: "req-1",
        text: "要件の文",
        kind: "existence",
        origin: { input_id: "in-source-1", quote: "原文の文の範囲" },
        parts: [],
      },
    ],
    open_issues: [],
    decisions: [],
    accepted_unwritable: [],
    confirmation: { sha256: "0".repeat(64), confirmed_at: "2026-10-10T00:00:00.000Z", confirmed_by: "operator" },
  };
}

/**
 * 確定した仕様と、その正しい SHA-256（`planDigest`）を作る。`confirmationSha` を渡すと、確認の値だけを
 * それにする（**失効した確認**を作る）。
 */
async function planFixture(
  confirmationSha?: string,
): Promise<{ readonly plan: Record<string, unknown>; readonly digest: string }> {
  const base = basePlan();
  const digest = await planDigest(base);
  const confirmation = { ...(base["confirmation"] as Record<string, unknown>), sha256: confirmationSha ?? digest };
  return { plan: { ...base, confirmation }, digest };
}

/**
 * `plan.json` つきの小さな納品物を作る。manifest と検証の結果の**どちらにも**、仕様の SHA-256 を載せる
 * （既定は正しい値）。`null` を渡すとその欄を書かない（食い違いの試験に使う）。
 */
async function makePlanBundle(
  fixture: { readonly plan: Record<string, unknown>; readonly digest: string },
  options: {
    readonly manifestPlanSha256?: string | null;
    readonly verificationPlanSha256?: string | null;
    readonly planText?: string;
  } = {},
): Promise<{ readonly root: string; readonly manifestSha256: string }> {
  const root = newBundleRoot();
  const files: BundleManifestFile[] = [];
  files.push(await writeEntry(root, BUNDLE_DECLARATION_PATH, DECLARATION));
  files.push(
    await writeEntry(root, BUNDLE_PLAN_PATH, options.planText ?? `${JSON.stringify(fixture.plan, null, 2)}\n`),
  );
  const verification: Record<string, unknown> = { declaration_sha256: "a".repeat(64) };
  const verificationPlanSha =
    options.verificationPlanSha256 === undefined ? fixture.digest : options.verificationPlanSha256;
  if (verificationPlanSha !== null) verification[PLAN_SHA256_FIELD] = verificationPlanSha;
  files.push(await writeEntry(root, BUNDLE_VERIFICATION_PATH, `${JSON.stringify(verification, null, 2)}\n`));
  const manifestPlanSha = options.manifestPlanSha256 === undefined ? fixture.digest : options.manifestPlanSha256;
  const text = writeManifest(root, files, "L2", manifestPlanSha);
  return { root, manifestSha256: await sha256Hex(encoder.encode(text)) };
}

/** `pins/commandagent.json` の写し。`warikan` にだけ値を入れる（ほかの見本は null）。 */
const pinsWith = (manifestSha256: string | null): Record<string, unknown> => ({
  delivery_bundles: {
    warikan: { manifest_sha256: manifestSha256, source_run: manifestSha256 === null ? null : "e_test_001" },
    "task-board": { manifest_sha256: null, source_run: null },
    dashboard: { manifest_sha256: null, source_run: null },
  },
});

/**
 * `warikan` には別の値、`task-board` にだけこの納品物の SHA-256 が入った pins の写し
 * （追記 1 の二点測定。見本を取り違えた納品物が止まることを確かめる）。
 */
const pinsOtherSampleMatches = (manifestSha256: string): Record<string, unknown> => ({
  delivery_bundles: {
    warikan: { manifest_sha256: "1".repeat(64), source_run: "e_test_001" },
    "task-board": { manifest_sha256: manifestSha256, source_run: "e_test_001" },
    dashboard: { manifest_sha256: null, source_run: null },
  },
});

// ── 書き込みの偽の口（R2 と D1）──────────────────────────────────

class RecordingSpecWriter implements SpecWriter {
  readonly writes: { readonly key: string; readonly body: string }[] = [];
  async write(key: string, body: string): Promise<void> {
    this.writes.push({ key, body });
  }
}

const SEED = "2026-09-26T00:00:00.000Z";

/** D1 の登録表の最小の再現（registry.ts が発行する 4 つの文に答える）。 */
class FakeRegistry implements RegistryExecutor {
  readonly apps = new Map<string, SqlRow>();
  readonly instances = new Map<string, SqlRow>();

  async query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]> {
    return this.#run(statement).rows as readonly Row[];
  }

  async execute(statement: SqlStatement): Promise<number> {
    return this.#run(statement).changes;
  }

  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    return statements.map((statement) => this.#run(statement));
  }

  #run(statement: SqlStatement): SqlResult {
    const params = statement.params ?? [];
    if (statement.sql.includes("INSERT INTO app_instances")) {
      const [instanceId, sha] = params;
      if (typeof instanceId === "string" && typeof sha === "string" && this.apps.has(sha) && !this.instances.has(instanceId)) {
        this.instances.set(instanceId, { instance_id: instanceId, source_sha256: sha, created_at: SEED });
      }
      return { rows: [], changes: 0 };
    }
    if (statement.sql.includes("INSERT INTO apps")) {
      const [sha, version, sourceKey, normalizedKey] = params;
      if (typeof sha === "string" && !this.apps.has(sha)) {
        this.apps.set(sha, {
          source_sha256: sha,
          schema_version: version,
          source_key: sourceKey,
          normalized_key: normalizedKey,
          created_at: SEED,
        });
      }
      return { rows: [], changes: 0 };
    }
    if (statement.sql.includes("FROM app_instances")) {
      const [instanceId] = params;
      const row = typeof instanceId === "string" ? this.instances.get(instanceId) : undefined;
      return { rows: row === undefined ? [] : [row], changes: 0 };
    }
    if (statement.sql.includes("FROM apps")) {
      const [sha] = params;
      const row = typeof sha === "string" ? this.apps.get(sha) : undefined;
      return { rows: row === undefined ? [] : [row], changes: 0 };
    }
    throw new Error(`偽の D1 が知らない文: ${statement.sql}`);
  }
}

interface Run {
  readonly writer: RecordingSpecWriter;
  readonly registry: FakeRegistry;
  readonly result: BundlePublishResult;
}

async function run(
  options: {
    readonly bundleDirectory: string;
    readonly pins?: unknown;
    readonly sample?: DeliveryBundleSample;
    readonly summaryStdout?: string;
    readonly instanceId?: string;
  },
): Promise<Run> {
  const writer = new RecordingSpecWriter();
  const registry = new FakeRegistry();
  const result = await publishBundle(
    { specs: writer, registry },
    {
      bundleDirectory: options.bundleDirectory,
      summaryStdout: options.summaryStdout ?? summaryLine(),
      pins: options.pins ?? pinsWith(null),
      sample: options.sample ?? "warikan",
      instanceId: options.instanceId ?? "e2e-warikan",
    },
  );
  return { writer, registry, result };
}

/** その実行が何も書かなかった（R2 も D1 も触らない）。 */
function expectNoWrites({ writer, registry }: Run): void {
  expect(writer.writes).toEqual([]);
  expect(registry.apps.size).toBe(0);
  expect(registry.instances.size).toBe(0);
}

// ── 受入条件 2：4 つとも通ると publish へ渡す ─────────────────────

describe("publishBundle — 4 つの門が通ると publish の中身へ渡す", () => {
  it("読み取った宣言のまま publishSpec へ渡し、R2 の 2 個と D1 の登録を行う（書き込みは偽の口）", async () => {
    const bundle = await makeBundle();
    const { writer, registry, result } = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("通るはず");
    expect(result.manifestSha256).toBe(bundle.manifestSha256);
    expect(result.level).toBe("L2");
    expect(result.pin.status).toBe("matched");
    expect(result.pin.matchedSamples).toEqual(["warikan"]);
    expect(result.publish.instance.instanceId).toBe("e2e-warikan");

    // R2 へ、原本と正規化した JSON の 2 個を、原本 SHA を含む決定的なキーへ置く
    expect(writer.writes).toHaveLength(2);
    expect(writer.writes[0]?.body).toBe(DECLARATION);
    expect(writer.writes[0]?.key).toMatch(/^specs\/[0-9a-f]{64}\/app\.spec\.yaml$/);
    expect(writer.writes[1]?.key).toMatch(/^specs\/[0-9a-f]{64}\/normalized\.json$/);
    expect(registry.apps.size).toBe(1);
    expect(registry.instances.size).toBe(1);
  });

  it("どの見本にも pins の値が入っていなければ、比較を飛ばして通す", async () => {
    const bundle = await makeBundle();
    const { result } = await run({ bundleDirectory: bundle.root, pins: pinsWith(null) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("通るはず");
    expect(result.pin.status).toBe("skipped");
  });
});

// ── 追記 1：pins は「その見本の値とだけ」比べる（二点測定）──────────

describe("publishBundle — 別の見本の値とだけ一致する納品物は止まる", () => {
  it("task-board の値とだけ一致する納品物を warikan として出すと、段 pins で止まり、何も書かない", async () => {
    const bundle = await makeBundle();
    const runResult = await run({
      bundleDirectory: bundle.root,
      pins: pinsOtherSampleMatches(bundle.manifestSha256),
      sample: "warikan",
    });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("pins");
    expect(runResult.result.pin?.status).toBe("mismatch");
    expect(runResult.result.pin?.samples).toEqual(["warikan"]);
    expectNoWrites(runResult);
  });

  it("同じ納品物でも、task-board として出せば通る（二点測定の裏）", async () => {
    const bundle = await makeBundle();
    const runResult = await run({
      bundleDirectory: bundle.root,
      pins: pinsOtherSampleMatches(bundle.manifestSha256),
      sample: "task-board",
    });

    expect(runResult.result.ok).toBe(true);
    if (!runResult.result.ok) throw new Error("通るはず");
    expect(runResult.result.pin.status).toBe("matched");
    expect(runResult.result.pin.matchedSamples).toEqual(["task-board"]);
    expect(runResult.writer.writes).toHaveLength(2);
  });
});

// ── 受入条件 1：どれかが落ちると publish しない ───────────────────

describe("publishBundle — 門が落ちると publish しない", () => {
  it("manifest の照合に通らないと、段 manifest で止まり、何も書かない", async () => {
    const bundle = await makeBundle({ tamper: BUNDLE_DECLARATION_PATH });
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("manifest");
    expect(runResult.result.problems.map((problem) => problem.kind)).toContain("sha256_mismatch");
    expectNoWrites(runResult);
  });

  it("manifest が読めないと、段 manifest で止まり、何も書かない", async () => {
    const bundle = await makeBundle();
    const runResult = await run({ bundleDirectory: join(bundle.root, "missing"), pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("manifest");
    expectNoWrites(runResult);
  });

  it("manifest の SHA-256 が pins の値と一致しないと、段 pins で止まり、何も書かない", async () => {
    const bundle = await makeBundle();
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith("0".repeat(64)) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("pins");
    expect(runResult.result.pin?.status).toBe("mismatch");
    expectNoWrites(runResult);
  });

  it("pins の形が壊れていると、段 pins で止まり、何も書かない", async () => {
    const bundle = await makeBundle();
    const runResult = await run({ bundleDirectory: bundle.root, pins: { delivery_bundles: { warikan: { manifest_sha256: 42 } } } });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("pins");
    expectNoWrites(runResult);
  });

  it("受け入れの条件を満たさない（verdict が full でない）と、段 acceptance で止まり、何も書かない", async () => {
    const bundle = await makeBundle();
    const runResult = await run({
      bundleDirectory: bundle.root,
      pins: pinsWith(bundle.manifestSha256),
      summaryStdout: summaryLine({ verdict: "partial" }),
    });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("acceptance");
    expect(runResult.result.acceptance?.reasons.map((reason) => reason.code)).toEqual(["verdict_not_full"]);
    expectNoWrites(runResult);
  });

  it("headless の出力が読めない（JSON の行が無い）と、段 acceptance で止まり、何も書かない", async () => {
    const bundle = await makeBundle();
    const runResult = await run({
      bundleDirectory: bundle.root,
      pins: pinsWith(bundle.manifestSha256),
      summaryStdout: "生成を開始します\n完了しました\n",
    });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("acceptance");
    expectNoWrites(runResult);
  });

  it("納品物の水準（artifact_level）が L2・L3・L4 でないと、段 acceptance で止まる", async () => {
    const bundle = await makeBundle({ artifactLevel: "L9" });
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("acceptance");
    expectNoWrites(runResult);
  });

  it("宣言が静的チェックに通らないと、段 declaration で止まり、診断を返して何も書かない", async () => {
    const bundle = await makeBundle({ declaration: "entities: []\n" });
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("declaration");
    expect(runResult.result.diagnostics.length).toBeGreaterThan(0);
    expectNoWrites(runResult);
  });

  it("納品物の中に宣言が無いと、段 declaration で止まり、何も書かない", async () => {
    const bundle = await makeBundle({ omitDeclaration: true });
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("declaration");
    expectNoWrites(runResult);
  });
});

// ── 受入条件：確定した仕様（plan.json）の門（Issue #335）──────────

describe("publishBundle — 確定した仕様（plan.json）の門", () => {
  it("plan.json の無い納品物は、今までどおり通る（planSha256 は null）", async () => {
    const bundle = await makeBundle();
    const { writer, result } = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("通るはず");
    expect(result.planSha256).toBeNull();
    expect(writer.writes).toHaveLength(2);
  });

  it("正しい plan.json つきは通る（manifest と検証の結果の SHA が一致する）", async () => {
    const fixture = await planFixture();
    const bundle = await makePlanBundle(fixture);
    const { writer, result } = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("通るはず");
    expect(result.planSha256).toBe(fixture.digest);
    expect(writer.writes).toHaveLength(2);
  });

  it("SHA が一致しない（manifest の値が違う）と、段 plan で plan_sha256_mismatch で断る", async () => {
    const fixture = await planFixture();
    const bundle = await makePlanBundle(fixture, { manifestPlanSha256: "f".repeat(64) });
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("plan");
    expect(runResult.result.plan?.code).toBe("plan_sha256_mismatch");
    expectNoWrites(runResult);
  });

  it("SHA が一致しない（検証の結果の値が違う）と、段 plan で plan_sha256_mismatch で断る", async () => {
    const fixture = await planFixture();
    const bundle = await makePlanBundle(fixture, { verificationPlanSha256: "f".repeat(64) });
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("plan");
    expect(runResult.result.plan?.code).toBe("plan_sha256_mismatch");
    expectNoWrites(runResult);
  });

  it("確認が失効している（confirmation の SHA が古い）と、段 plan で confirmation_expired で断る", async () => {
    const fixture = await planFixture("0".repeat(64));
    const bundle = await makePlanBundle(fixture);
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("plan");
    expect(runResult.result.plan?.code).toBe("confirmation_expired");
    expectNoWrites(runResult);
  });

  it("検査に通らない plan.json は、段 plan で plan_invalid と診断のコードを返す", async () => {
    const fixture = await planFixture();
    fixture.plan["open_issues"] = [{ id: "oi-1", text: "未解決の事項", critical: true, status: "open" }];
    const bundle = await makePlanBundle(fixture);
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("plan");
    expect(runResult.result.plan?.code).toBe("plan_invalid");
    expect(runResult.result.plan?.problems.map((problem) => problem.code)).toContain("open_critical");
    expectNoWrites(runResult);
  });

  it("plan.json が JSON として読めないと、段 plan で plan_unreadable で断る", async () => {
    const fixture = await planFixture();
    const bundle = await makePlanBundle(fixture, { planText: "{ not json\n" });
    const runResult = await run({ bundleDirectory: bundle.root, pins: pinsWith(bundle.manifestSha256) });

    expect(runResult.result.ok).toBe(false);
    if (runResult.result.ok) throw new Error("落ちるはず");
    expect(runResult.result.stage).toBe("plan");
    expect(runResult.result.plan?.code).toBe("plan_unreadable");
    expectNoWrites(runResult);
  });
});

// ── pins の照合（純粋関数）─────────────────────────────────────────

describe("compareBundleManifestToPins", () => {
  const SHA = "a".repeat(64);

  it("どの見本にも値が入っていなければ skipped（比較を飛ばしたことを返す）", () => {
    const result = compareBundleManifestToPins(SHA, pinsWith(null), "warikan");
    expect(result).toEqual({ status: "skipped", samples: [], matchedSamples: [] });
  });

  it("値のどれかと一致すれば matched（一致した見本を返す）", () => {
    const result = compareBundleManifestToPins(SHA, pinsWith(SHA), "warikan");
    expect(result.status).toBe("matched");
    expect(result.samples).toEqual(["warikan"]);
    expect(result.matchedSamples).toEqual(["warikan"]);
  });

  it("値が入っているのにどれとも一致しなければ mismatch", () => {
    const result = compareBundleManifestToPins(SHA, pinsWith("0".repeat(64)), "warikan");
    expect(result.status).toBe("mismatch");
    expect(result.samples).toEqual(["warikan"]);
    expect(result.matchedSamples).toEqual([]);
  });

  it("その見本の値とだけ比べる（別の見本が一致しても mismatch。追記 1）", () => {
    const pins = pinsOtherSampleMatches(SHA);
    expect(compareBundleManifestToPins(SHA, pins, "warikan")).toEqual({ status: "mismatch", samples: ["warikan"], matchedSamples: [] });
    expect(compareBundleManifestToPins(SHA, pins, "task-board")).toEqual({
      status: "matched",
      samples: ["task-board"],
      matchedSamples: ["task-board"],
    });
  });

  it("その見本の値が null なら、別の見本が一致していても skipped（比較を飛ばす）", () => {
    const pins = { delivery_bundles: { warikan: { manifest_sha256: null }, "task-board": { manifest_sha256: SHA } } };
    expect(compareBundleManifestToPins(SHA, pins, "warikan")).toEqual({ status: "skipped", samples: [], matchedSamples: [] });
  });

  it("delivery_bundles が無ければ BundlePinError（pins_malformed）", () => {
    const thrown = (() => {
      try {
        return compareBundleManifestToPins(SHA, {}, "warikan");
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(BundlePinError);
    expect((thrown as BundlePinError).code).toBe("pins_malformed");
  });

  it("値が文字列でも null でもなければ BundlePinError（安全側に倒す）", () => {
    const thrown = (() => {
      try {
        return compareBundleManifestToPins(SHA, { delivery_bundles: { warikan: { manifest_sha256: 1234 } } }, "warikan");
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(BundlePinError);
  });
});
