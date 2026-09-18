// data-api Worker の受入試験（Issue #6）。
//
//   1. 外部ルートを持たないことを、wrangler が解決した設定で env ごとに確かめる
//   2. D1 / R2 / DO の binding が env ごとに書かれ、DO の migration が app-do の正本と一致する
//   3. 本物の workerd の上で /healthz が 200 を返し、D1 / R2 / DO を実際に踏んでいる
//   4. D1 のマイグレーション（Issue #12）：SQL は control-plane に置き、data-api の設定で当てる。
//      runbook の適用コマンドを env.dev に --local で実際に叩き、全部当たることを確かめる
//
// モックにしないのは app-do と同じ理由：binding が「解決している」ことの証明は、
// 解決した binding を実際に叩くことでしか得られない。
//
// wrangler / vitest は devDependencies に無い。ルートの package.json に集約してある（app-do と同じ）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";
import { sampleScenarioFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import { normalizeSpec } from "@musunest/spec-engine";
import type { DataApiEnv } from "./cloudflare.js";
import { PROBE_DO_NAME, PROBE_OBJECT_KEY } from "./cloudflare.js";
import {
  API_CREATED_STATUS,
  API_READ_STATUS,
  BUNDLES_BINDING,
  CONTROL_DB_BINDING,
  HEALTHZ_PATH,
  PACKAGE_NAME,
  UPLOADS_BINDING,
  apiActionPath,
  apiSpecPath,
  apiViewPath,
} from "./contract.js";
import type { HealthzBody } from "./contract.js";

// tsconfig の lib は ES2022 ＋ workers-types だけなので ImportMeta.url が型に無い。
// このファイルは workerd ではなく Node（vitest）の側で動くので、ここだけ局所的に補う。
const HERE = (import.meta as ImportMeta & { url: string }).url;
const CONFIG_PATH = new URL("../wrangler.jsonc", HERE);
/** DO の class_name / migration の正本（03 §4・app-do の wrangler.jsonc 冒頭） */
const APP_DO_CONFIG_PATH = new URL("../../app-do/wrangler.jsonc", HERE);
const BOOT_TIMEOUT_MS = 120_000;

/** D1 マイグレーションの SQL の置き場（docs/runbook/d1-migration.md §1）。D1 は Control Plane 専用 */
const CONTROL_PLANE_MIGRATIONS_DIR = new URL("../../control-plane/migrations/", HERE);
const REPO_ROOT = new URL("../../../", HERE);
const WRANGLER_CLI = new URL("../../../node_modules/wrangler/bin/wrangler.js", HERE);

const ENVS = ["dev", "staging", "production"] as const;

const readConfig = (path: URL, env?: string) =>
  unstable_readConfig(
    { config: decodeURIComponent(path.pathname), ...(env === undefined ? {} : { env }) },
    { hideWarnings: true },
  );

describe("data-api パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/data-api");
  });
});

describe.each(ENVS)("wrangler.jsonc（env.%s）", (env) => {
  const config = readConfig(CONFIG_PATH, env);
  const appDo = readConfig(APP_DO_CONFIG_PATH);

  it("Worker 名が musunest-<env>-data-api（gateway の Service Binding の宛先）", () => {
    expect(config.name).toBe(`musunest-${env}-data-api`);
  });

  it("外部ルートを持たない：workers.dev・Preview URL・routes のどれも無い", () => {
    // Service Binding は呼ぶ側が Worker 名で結ぶので、到達経路を1つも作らなくても届く。
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes ?? []).toEqual([]);
    expect(config.route).toBeUndefined();
  });

  it("D1 は CONTROL_DB の1つだけで、その env の control データベースを指す", () => {
    expect(config.d1_databases).toEqual([
      expect.objectContaining({
        binding: CONTROL_DB_BINDING,
        database_name: `musunest-${env}-control`,
        database_id: expect.any(String),
      }),
    ]);
  });

  it("CONTROL_DB の migrations_dir が packages/control-plane/migrations を指す（SQL は control-plane・適用は data-api の設定）", () => {
    // control-plane には wrangler の設定が無く、infra:sync も database_id を書き戻さない。
    // だから CONTROL_DB を binding している data-api の設定から当てる。3環境とも同じ SQL を当てる。
    const [controlDb] = config.d1_databases;
    expect(controlDb?.migrations_dir).toBe("../control-plane/migrations");
    // wrangler は設定ファイルのディレクトリから解決する（2026-09-14 実測・wrangler 4.131.1）
    expect(new URL(`${controlDb?.migrations_dir}/`, CONFIG_PATH).href).toBe(CONTROL_PLANE_MIGRATIONS_DIR.href);
    // 適用済みの記録は既定の d1_migrations 表。runbook の巻き戻し手順（§5）がこの名前を前提にする
    expect(controlDb?.migrations_table).toBeUndefined();
  });

  it("R2 は BUNDLES と UPLOADS で、その env のバケットを指す", () => {
    expect(config.r2_buckets).toEqual([
      expect.objectContaining({ binding: BUNDLES_BINDING, bucket_name: `musunest-${env}-bundles` }),
      expect.objectContaining({ binding: UPLOADS_BINDING, bucket_name: `musunest-${env}-uploads` }),
    ]);
  });

  it("DO の binding と migration が app-do の正本と一致する（new_sqlite_classes）", () => {
    expect(config.durable_objects.bindings).toEqual(appDo.durable_objects.bindings);
    expect(config.migrations).toEqual(appDo.migrations);
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["AppInstanceDO"] }]);
  });

  it("vars.ENVIRONMENT がその env を名乗る", () => {
    expect(config.vars).toMatchObject({ ENVIRONMENT: env });
  });

  it("infra:sync が扱えない binding（KV・Queue consumer）を持たない", () => {
    expect(config.kv_namespaces).toEqual([]);
    expect(config.queues.consumers ?? []).toEqual([]);
  });

  it("limits はどの環境にも無い（Issue #152 の実験で dev にだけ一時的に入れたのを、手順 6 で外した）", () => {
    // Issue #152 は、Free の 10 ms の壁をアカウント①の中で再現するために `env.dev` へ `limits: { cpu_ms: 10 }` を
    // 一時的に入れた。実験が終わったので外してある。**どの環境にも残っていないこと**を、ここで固定する。
    // （staging・production には初めから入れていない。Free の上限はアカウント単位で、②は Free のままである。）
    expect(config.limits).toBeUndefined();
  });
});

describe.each(ENVS)("data-api Worker（env.%s・workerd 上の実機）", (env) => {
  const server = createTestHarness({
    workers: [{ configPath: CONFIG_PATH, env, vars: { GIT_SHA: "test-sha" } }],
  });

  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("GET /healthz が 200 を返し、D1 / R2 / DO が全部 ok", async () => {
    const res = await server.fetch(HEALTHZ_PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthzBody;
    expect(body).toEqual({
      service: "data-api",
      env,
      version: "test-sha",
      checks: { d1: "ok", r2: "ok", do: "ok" },
      elapsed_ms: expect.any(Number),
    });
  });

  it("binding が解決している：healthz が R2 と DO（SQLite）に実際に書いている", async () => {
    await server.fetch(HEALTHZ_PATH);
    const worker = server.getWorker<DataApiEnv>();

    const bindings = await worker.getEnv();
    expect(Object.keys(bindings)).toEqual(
      expect.arrayContaining([CONTROL_DB_BINDING, BUNDLES_BINDING, UPLOADS_BINDING, "APP_DO"]),
    );
    expect(await bindings.BUNDLES.head(PROBE_OBJECT_KEY)).not.toBeNull();

    const sql = await worker.getDurableObjectStorage("APP_DO", { name: PROBE_DO_NAME });
    expect(await sql.exec("SELECT k FROM _probe")).toEqual([{ k: "healthz" }]);
  });

  it("/healthz 以外のパスは 404", async () => {
    const res = await server.fetch("/");
    expect(res.status).toBe(404);
  });

  it("GET 以外は 405", async () => {
    const res = await server.fetch(HEALTHZ_PATH, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

// ── D1 マイグレーション（docs/runbook/d1-migration.md §2.1）─────────────────────────
//
// SQL を当てる経路は wrangler の d1 migrations だけで、ほかのゲートはどれも SQL を読まない。
// ここで当てておかないと、壊れた migration は main へのマージ後に staging の CD（04 §4 ①）で初めて落ちる。
// runbook の適用コマンドをリポジトリ直下からそのまま叩く。違いは2つだけ：
//   - `pnpm exec wrangler` ではなく wrangler の CLI を node で直接起動する
//   - `--persist-to` で一時ディレクトリへ逃がす（開発者の packages/data-api/.wrangler/state に触れない）

/**
 * tsconfig の types は workers-types だけで、Node の型を読まない（src は workerd 向け）。
 * wrangler を子プロセスで起動するところだけ Node の API が要るので、使う形だけを局所的に書く。
 */
interface NodeApis {
  execFileSync(
    file: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      encoding: "utf8";
      stdio: ["ignore", "pipe", "pipe"];
      timeout: number;
    },
  ): string;
  mkdtempSync(prefix: string): string;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
  rmSync(path: string, options: { recursive: true; force: true }): void;
  tmpdir(): string;
}

// 文字列リテラルで import すると tsc が型を探しに行くので、引数を経由する
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

async function loadNodeApis(): Promise<NodeApis> {
  const [childProcess, fs, os] = await Promise.all([
    importUntyped("node:child_process"),
    importUntyped("node:fs"),
    importUntyped("node:os"),
  ]);
  return {
    execFileSync: childProcess.execFileSync,
    mkdtempSync: fs.mkdtempSync,
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    rmSync: fs.rmSync,
    tmpdir: os.tmpdir,
  };
}

const node = await loadNodeApis();
const WRANGLER_TIMEOUT_MS = 60_000;

const wrangler = (...args: string[]) =>
  node.execFileSync(process.execPath, [decodeURIComponent(WRANGLER_CLI.pathname), ...args], {
    cwd: decodeURIComponent(REPO_ROOT.pathname),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
    // stdin を渡さない＝非対話。確認は既定値（yes）で進む。CD のランナーと同じ条件
    stdio: ["ignore", "pipe", "pipe"],
    timeout: WRANGLER_TIMEOUT_MS,
  });

const sqlFiles = () =>
  node
    .readdirSync(decodeURIComponent(CONTROL_PLANE_MIGRATIONS_DIR.pathname))
    .filter((name) => name.endsWith(".sql"))
    .sort();

describe("D1 マイグレーション（packages/control-plane/migrations）", () => {
  let persistTo = "";

  /** runbook §2.1 の `--env dev --config packages/data-api/wrangler.jsonc --local` に `--persist-to` を足したもの */
  const devLocal = () => [
    "--env", "dev", "--config", "packages/data-api/wrangler.jsonc", "--local", "--persist-to", persistTo,
  ];

  const query = <Row>(sql: string): Row[] => {
    const out = wrangler("d1", "execute", CONTROL_DB_BINDING, ...devLocal(), "--json", "--command", sql);
    const [result] = JSON.parse(out) as [{ results: Row[] }];
    return result.results;
  };

  beforeAll(() => {
    persistTo = node.mkdtempSync(`${node.tmpdir()}/musunest-d1-migrations-`);
    // 2回当てる。CD は main への push のたびに当てるので、2回目が何も当てないことまでが契約
    wrangler("d1", "migrations", "apply", CONTROL_DB_BINDING, ...devLocal());
    wrangler("d1", "migrations", "apply", CONTROL_DB_BINDING, ...devLocal());
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (persistTo !== "") node.rmSync(persistTo, { recursive: true, force: true });
  });

  it("ファイル名は <4桁の連番>_<名前>.sql で、0001 から欠番も重複もなく並ぶ", () => {
    // wrangler はファイル名の順に当てる。番号が衝突・前後すると、環境によって当たる順が変わりうる（runbook §1.2）
    const files = sqlFiles();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((name, i) => {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(name.slice(0, 4)).toBe(String(i + 1).padStart(4, "0"));
    });
  });

  it("適用コマンドで env.dev に --local で全部当たり、2回目は何も当てない（d1_migrations に1件ずつ）", () => {
    const applied = query<{ name: string }>("SELECT name FROM d1_migrations ORDER BY id");
    expect(applied.map((row) => row.name)).toEqual(sqlFiles());
  });

  it("0001 が _musunest_meta を作る（03 §7）", () => {
    const tables = query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_musunest_meta'",
    );
    expect(tables).toEqual([{ name: "_musunest_meta" }]);
  });
});

// ══ アプリの経路（Issue #102）══════════════════════════════════════════════════
//
// 実機（workerd・本物の D1 / R2 / DO）の binding を通した **HTTP の作法**を見る。
// 判定そのもの（入力の検査・権限・整合性の照合）は src/app-api.test.ts が差し替えた依存で見るので、
// ここは **HTTP でしか見えないこと**に絞る:
//   - 経路の解析と method（200 / 201 / 404 / 405）
//   - body の読み取り（**生の 1e400 をそのまま送る**。JSON.stringify が Infinity を null に化けさせた
//     テストでは代用できない。samples/expense-log/scenario.json の 11 手目がそれである）
//   - 誤りコード（400 / 403 / 404 / 405 / 422 / 503）と、**応答に内部情報を載せないこと**
//   - 時計を HTTP から上書きできないこと（ヘッダ・query に偽の日時を足しても保存日時が変わらない。Q17）
//   - 拒否した操作が DO の件数も内容も変えないこと
//   - 19 操作を本物の経路で流したときの、最後の一覧（採点のシナリオと突き合わせる）
//
// 保存先は隔離する。このテストが使うインスタンスは専用の ID を持ち、開始時に DO の行と
// R2 のオブジェクトを自分で用意する（前の実行の残りに依らない）。

const APP_INSTANCE = "issue-102-app";
/** read だけを宣言した宣言（`write` を外した） */
const READONLY_INSTANCE = "issue-102-readonly";
/** write だけを宣言した宣言（`read` を外した） */
const NOWRITE_INSTANCE = "issue-102-noread";
/** 壊れた JSON のオブジェクトを指すインスタンス */
const BROKEN_INSTANCE = "issue-102-broken";
/** R2 にオブジェクトが無いインスタンス */
const NO_OBJECT_INSTANCE = "issue-102-no-object";
const UNKNOWN_INSTANCE = "issue-102-unknown";

const expenseSource = node.readFileSync(decodeURIComponent(sampleSpecFile("expense-log").pathname), "utf8");
const expenseNormalized = await normalizeSpec(expenseSource);
if (!expenseNormalized.ok) throw new Error("見本が静的チェックに通らない");
const expenseScenario = JSON.parse(
  node.readFileSync(decodeURIComponent(sampleScenarioFile("expense-log").pathname), "utf8"),
) as {
  readonly clock: string;
  readonly steps: readonly {
    readonly name: string;
    readonly action: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly expect: { readonly accepted?: true; readonly rejected?: unknown };
  }[];
  readonly views: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
};

const APP_SHA = expenseNormalized.app.sourceSha256;

/**
 * 登録する 1 件。**`apps` は原本の SHA-256 で引く**ので、宣言を変えたインスタンスは
 * 別の SHA-256 で登録する（同じ SHA は 1 つの登録＝1 つの `normalized_key` しか持てない）。
 * 宣言の `sourceSha256` も登録に合わせる（食い違えば、実装が 503 にする——それは別のテストで見る）。
 */
interface Seeded {
  readonly instance: string;
  readonly sourceSha256: string;
  readonly normalizedKey: string;
  readonly text: string;
}

const seeded = (
  instance: string,
  sourceSha256: string,
  text: string,
): Seeded => ({
  instance,
  sourceSha256,
  normalizedKey: `specs/${sourceSha256}/normalized.json`,
  text,
});

/** `permissions` を差し替えた宣言の本文（原本の SHA-256 も登録に合わせる） */
const withPermissions = (names: readonly string[], sourceSha256: string): string =>
  JSON.stringify({
    ...expenseNormalized.app,
    sourceSha256,
    spec: {
      ...expenseNormalized.app.spec,
      permissions: expenseNormalized.app.spec.permissions.filter((permission) =>
        names.includes(permission.name),
      ),
    },
  });

const READONLY_SHA = "b".repeat(64);
const NOWRITE_SHA = "c".repeat(64);
const BROKEN_SHA = "d".repeat(64);
const NO_OBJECT_SHA = "e".repeat(64);

const SEEDED: readonly Seeded[] = [
  seeded(APP_INSTANCE, APP_SHA, expenseNormalized.json),
  seeded(READONLY_INSTANCE, READONLY_SHA, withPermissions(["read"], READONLY_SHA)),
  seeded(NOWRITE_INSTANCE, NOWRITE_SHA, withPermissions(["write"], NOWRITE_SHA)),
  seeded(BROKEN_INSTANCE, BROKEN_SHA, '{"schemaVersion":'),
  // 登録はあるが、R2 にオブジェクトを置かない
  seeded(NO_OBJECT_INSTANCE, NO_OBJECT_SHA, ""),
];

/** 通る入力（POST の本文に使う） */
const VALID_INPUT: Readonly<Record<string, unknown>> = {
  description: "夕食",
  amount: 6600,
  discount: 600,
  payer: "A",
  participants: ["A", "B", "C"],
};

/**
 * 生の JSON 本文を組む。**有限でない数は 1e400 と書く**——`JSON.stringify` は Infinity を null に
 * 化けさせるので、それでは「有限の数だけを受け取る」を測れない（受入条件）。
 */
function bodyOf(input: Readonly<Record<string, unknown>>): string {
  const pairs = Object.entries(input).map(([key, value]) => {
    if (typeof value === "number" && !Number.isFinite(value)) return `${JSON.stringify(key)}:1e400`;
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  });
  return `{${pairs.join(",")}}`;
}

describe("アプリの経路（env.dev・workerd 上の実機）", () => {
  const server = createTestHarness({
    workers: [{ configPath: CONFIG_PATH, env: "dev", vars: { GIT_SHA: "test-sha" } }],
  });

  /** 実機の binding。**外から D1 / R2 / DO を読み書きして、保存の結果を直に見る** */
  const bindings = async (): Promise<DataApiEnv> => server.getWorker<DataApiEnv>().getEnv();

  const storage = (instance: string) =>
    server.getWorker().getDurableObjectStorage("APP_DO", { name: instance });

  /**
   * DO の生の行（メモリ上の写しではなく、実 SQLite の行を見る）。
   * **先に HTTP を 1 回通して DO を起こす**——表は DO のコンストラクタが作るので、
   * 一度も起こしていない DO に SQL を投げると表が無い。
   */
  const rawRows = async (instance: string): Promise<Record<string, unknown>[]> => {
    const store = await storage(instance);
    return await store.exec("SELECT id, data, created_at FROM records ORDER BY ordering");
  };

  const clearRecords = async (instance: string): Promise<void> => {
    await (await storage(instance)).exec("DELETE FROM records");
  };

  const post = (
    instance: string,
    action: string,
    body: string,
    headers?: Record<string, string>,
  ) =>
    server.fetch(apiActionPath(instance, action), {
      method: "POST",
      body,
      ...(headers === undefined ? {} : { headers }),
    });

  beforeAll(async () => {
    await server.listen();

    const env = await bindings();
    // 表はマイグレーションの現物をそのまま当てる（このハーネスの D1 はテスト専用の隔離されたもの）。
    // D1 の exec はコメントだけの行を文として数えないので、注釈を落としてから渡す
    for (const name of sqlFiles()) {
      const text = node.readFileSync(
        `${decodeURIComponent(CONTROL_PLANE_MIGRATIONS_DIR.pathname)}${name}`,
        "utf8",
      );
      const statements = text
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"))
        .join("\n");
      // D1 の exec は 1 行 1 文として読むので、複数行の CREATE TABLE は通らない。
      // `;` で切り分けて batch に渡す（1 トランザクションで当てる）
      await env.CONTROL_DB.batch(
        statements
          .split(";")
          .map((statement) => statement.trim())
          .filter((statement) => statement !== "")
          .map((statement) => env.CONTROL_DB.prepare(statement)),
      );
    }
    for (const seed of SEEDED) {
      await env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO apps (source_sha256, schema_version, source_key, normalized_key) VALUES (?, ?, ?, ?)",
      )
        .bind(
          seed.sourceSha256,
          expenseNormalized.app.schemaVersion,
          `specs/${seed.sourceSha256}/app.spec.yaml`,
          seed.normalizedKey,
        )
        .run();
      await env.CONTROL_DB.prepare(
        "INSERT OR REPLACE INTO app_instances (instance_id, source_sha256) VALUES (?, ?)",
      )
        .bind(seed.instance, seed.sourceSha256)
        .run();
      // 空の本文は「置かない」の意味である（NO_OBJECT_INSTANCE は R2 にオブジェクトを持たない）
      if (seed.text === "") await env.BUNDLES.delete(seed.normalizedKey);
      else await env.BUNDLES.put(seed.normalizedKey, seed.text);
    }

    // DO を起こしてから、前の実行の残りを消す（採点する一覧の行数が 4 であることを毎回成り立たせる）
    expect((await server.fetch(apiViewPath(APP_INSTANCE, "expenseList"))).status).toBe(200);
    expect((await server.fetch(apiViewPath(READONLY_INSTANCE, "expenseList"))).status).toBe(200);
    await clearRecords(APP_INSTANCE);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("GET spec が 200 で、正規化した JSON を返す", async () => {
    const res = await server.fetch(apiSpecPath(APP_INSTANCE));
    expect(res.status).toBe(API_READ_STATUS);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["schemaVersion"]).toBe(expenseNormalized.app.schemaVersion);
    expect(body["sourceSha256"]).toBe(APP_SHA);
    expect(body["permissions"]).toEqual({ read: true, write: true });
    expect(body["actions"]).toEqual([{ name: "addExpense", entity: "expense" }]);
    expect(body["spec"]).toEqual(expenseNormalized.app.spec);
  });

  it("GET 一覧が 200 で、宣言順の列と操作の可否を返す", async () => {
    const res = await server.fetch(apiViewPath(APP_INSTANCE, "expenseList"));
    expect(res.status).toBe(API_READ_STATUS);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["fields"]).toEqual(["description", "amount", "discount", "payer", "participants"]);
    expect(body["computed"]).toEqual(["paidAmount", "headcount", "shareAmount"]);
    expect(body["actions"]).toEqual([{ name: "addExpense", entity: "expense" }]);
  });

  it("POST が 201 で、書いた行（計算値つき）を返す", async () => {
    const res = await post(
      APP_INSTANCE,
      "addExpense",
      JSON.stringify({
        description: "夕食",
        amount: 6600,
        discount: 600,
        payer: "A",
        participants: ["A", "B", "C"],
      }),
    );
    expect(res.status).toBe(API_CREATED_STATUS);
    const row = (await res.json()) as Record<string, unknown>;
    expect(row["fields"]).toEqual({
      description: "夕食",
      amount: 6600,
      discount: 600,
      payer: "A",
      participants: ["A", "B", "C"],
    });
    expect(row["computed"]).toEqual({ paidAmount: 6000, headcount: 3, shareAmount: 2000 });
    expect(typeof row["id"]).toBe("string");
  });

  it("生の 1e400 をそのまま送ると、amount の型検査で 422 になる", async () => {
    // この本文は JSON.stringify では作れない（Infinity が null に化ける）。
    // 化けたテストで代用していないことを、ここで本文そのものに対して確かめる
    const raw = `{"description":"昼食","amount":1e400,"discount":0,"payer":"A","participants":["A"]}`;
    expect(JSON.parse(raw)).toMatchObject({ amount: Number.POSITIVE_INFINITY });
    expect(JSON.stringify(JSON.parse(raw) as Record<string, unknown>)).toContain('"amount":null');

    const res = await post(APP_INSTANCE, "addExpense", raw);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "INPUT_REJECTED",
      fields: ["amount"],
      validations: [],
    });
  });

  it("JSON 構文が不正なら 400（型の検査へ進まない）", async () => {
    const res = await post(APP_INSTANCE, "addExpense", '{"description":');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_JSON" });
  });

  it.each([
    ["read を外した宣言の一覧", apiViewPath(NOWRITE_INSTANCE, "expenseList"), "GET"],
    ["read を外した宣言の spec", apiSpecPath(NOWRITE_INSTANCE), "GET"],
  ] as const)("%s は 403", async (_label, path, method) => {
    const res = await server.fetch(path, { method });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "PERMISSION_DENIED" });
  });

  it("write を外した宣言の追加は 403 で、保存もしない", async () => {
    const before = await rawRows(READONLY_INSTANCE);
    const res = await post(
      READONLY_INSTANCE,
      "addExpense",
      JSON.stringify({ description: "夕食", amount: 100, discount: 0, payer: "A", participants: ["A"] }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "PERMISSION_DENIED" });
    expect(await rawRows(READONLY_INSTANCE)).toEqual(before);
  });

  it.each([
    ["知らない instance", apiSpecPath(UNKNOWN_INSTANCE), "GET"],
    ["知らない view", apiViewPath(APP_INSTANCE, "memberList"), "GET"],
    ["知らない action", apiActionPath(APP_INSTANCE, "deleteExpense"), "POST"],
    ["契約に無い経路", `/api/instances/${APP_INSTANCE}/records`, "GET"],
  ] as const)("%s は 404", async (_label, path, method) => {
    const res = await server.fetch(path, { method });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("経路が受けない method は 405 で、受ける method を allow に載せる", async () => {
    const read = await server.fetch(apiSpecPath(APP_INSTANCE), { method: "POST" });
    expect(read.status).toBe(405);
    expect(read.headers.get("allow")).toBe("GET");
    expect(await read.json()).toEqual({ error: "METHOD_NOT_ALLOWED" });

    const write = await server.fetch(apiActionPath(APP_INSTANCE, "addExpense"), {
      method: "GET",
    });
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("POST");
  });

  it("登録が無い・R2 が無い・壊れた JSON は、成功応答にも書込にもならない", async () => {
    // 登録が無い
    const missing = await server.fetch(apiSpecPath(UNKNOWN_INSTANCE));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "NOT_FOUND" });

    for (const instance of [NO_OBJECT_INSTANCE, BROKEN_INSTANCE]) {
      const spec = await server.fetch(apiSpecPath(instance));
      expect(spec.status, instance).toBe(503);
      // 本文はコード 1 つだけである（**例外の文言も、R2 のキーも、binding の名前も載せない**）
      expect(await spec.json(), instance).toEqual({ error: "SPEC_UNAVAILABLE" });

      const created = await post(instance, "addExpense", bodyOf(VALID_INPUT));
      expect(created.status, instance).toBe(503);
      expect(await created.json(), instance).toEqual({ error: "SPEC_UNAVAILABLE" });
      expect(await rawRows(instance), instance).toEqual([]);
    }
  });

  it("不明な ID を 404 で返しても、送った値を応答に写さない", async () => {
    const secret = "MUSUNEST-PROBE-TOKEN-LOOKALIKE";
    const res = await server.fetch(`/api/instances/${secret}/spec`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toEqual({ error: "NOT_FOUND" });
  });

  it("ヘッダ・query に偽の日時を足しても、保存日時は変わらない（Q17）", async () => {
    const fake = "1999-01-01T00:00:00.000Z";
    const res = await post(
      APP_INSTANCE,
      "addExpense",
      JSON.stringify({
        description: "時計の検査",
        amount: 1,
        discount: 0,
        payer: "A",
        participants: ["A"],
      }),
      {
        "X-Musunest-Now": fake,
        "X-Musunest-Clock": fake,
        "X-Musunest-Date": fake,
      },
    );
    expect(res.status).toBe(API_CREATED_STATUS);
    const row = (await res.json()) as { createdAt: string; updatedAt: string };
    expect(row.createdAt).not.toBe(fake);
    expect(row.updatedAt).not.toBe(fake);
    // 実時計の値である（このテストを走らせた時刻の近く）
    expect(Math.abs(Date.parse(row.createdAt) - Date.now())).toBeLessThan(10 * 60 * 1000);

    // 保存された行も同じ値である（応答だけが実時計、ではない）
    const stored = await rawRows(APP_INSTANCE);
    const last = stored.at(-1);
    expect(last?.["created_at"]).toBe(row.createdAt);
    expect(JSON.stringify(stored)).not.toContain(fake);
  });

  it("拒否した操作は、DO の件数も内容も変えない", async () => {
    const before = JSON.stringify(await rawRows(APP_INSTANCE));
    const rejected = await post(
      APP_INSTANCE,
      "addExpense",
      JSON.stringify({ description: "返品", amount: 0, discount: -100, payer: "A", participants: ["A"] }),
    );
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({
      error: "INPUT_REJECTED",
      fields: [],
      validations: ["positiveAmount", "nonNegativeDiscount"],
    });
    expect(JSON.stringify(await rawRows(APP_INSTANCE))).toBe(before);
  });

  it("読取を繰り返しても計算の値は返るが、DO の入力データは変わらない", async () => {
    const before = JSON.stringify(await rawRows(APP_INSTANCE));
    const first = await server.fetch(apiViewPath(APP_INSTANCE, "expenseList"));
    const second = await server.fetch(apiViewPath(APP_INSTANCE, "expenseList"));
    expect(first.status).toBe(200);
    const [firstBody, secondBody] = (await Promise.all([first.json(), second.json()])) as [
      { rows: readonly Record<string, unknown>[] },
      { rows: readonly Record<string, unknown>[] },
    ];
    expect(secondBody).toEqual(firstBody);

    expect(secondBody.rows.length).toBeGreaterThan(0);
    for (const row of secondBody.rows) {
      expect(Object.keys(row["computed"] as object)).toEqual([
        "paidAmount",
        "headcount",
        "shareAmount",
      ]);
    }
    // 計算の値は保存されない（行そのものが増えも変わらない）
    expect(JSON.stringify(await rawRows(APP_INSTANCE))).toBe(before);
  });

  it("19 操作を本物の経路で流すと、受理 4 件・拒否 15 件で、最後の一覧が採点のシナリオと一致する", async () => {
    // このインスタンスの DO を空にしてから流す（4 行ちょうどを確かめるため）
    await clearRecords(APP_INSTANCE);

    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const step of expenseScenario.steps) {
      const res = await post(APP_INSTANCE, step.action, bodyOf(step.input));
      if (step.expect.accepted === true) {
        expect(res.status, step.name).toBe(API_CREATED_STATUS);
        accepted.push(step.name);
      } else {
        expect(res.status, step.name).toBe(422);
        const body = (await res.json()) as { fields: readonly string[]; validations: readonly string[] };
        const expected = step.expect.rejected as { fields: readonly string[]; validations: readonly string[] };
        // 項目の順は問わない（意味の文書）ので、名前の集合として比べる
        expect(new Set(body.fields), step.name).toEqual(new Set(expected.fields));
        expect(body.validations, step.name).toEqual(expected.validations);
        rejected.push(step.name);
      }
    }
    expect({ accepted: accepted.length, rejected: rejected.length }).toEqual({
      accepted: 4,
      rejected: 15,
    });
    expect(accepted).toEqual([
      "夕食を入れる（クーポン 600 円）",
      "タクシーを入れる",
      "割引が金額を超えても保存し、払った額は 0 にする",
      "内容が空の文字列でも保存する（M1.1 に必須の指定は無い）",
    ]);
    // 空文字の description は受理され、空・重複・型違いの participants は拒否される
    expect(rejected).toEqual(
      expect.arrayContaining([
        "割る人が空なら断る",
        "割る人が重なっていたら断る",
        "割る人に文字列でないものがあれば断る",
        "金額が有限の数でなければ断る",
      ]),
    );

    const list = await server.fetch(apiViewPath(APP_INSTANCE, "expenseList"));
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      rows: readonly { fields: Record<string, unknown>; computed: Record<string, unknown> }[];
    };
    const expectedRows = expenseScenario.views["expenseList"] ?? [];
    expect(body.rows).toHaveLength(4);
    expect(body.rows.map((row) => ({ ...row.fields, ...row.computed }))).toEqual(expectedRows);

    // DO の行は、採点の 4 行と同じ数だけである（計算の値は保存しない）
    const stored = await rawRows(APP_INSTANCE);
    expect(stored).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toContain("paidAmount");
  }, BOOT_TIMEOUT_MS);
});

// ── 境界（data-api の公開面は Worker を巻き込まない）─────────────────────────
//
// gateway（Service Binding で data-api を呼ぶ側）と host（sdk 経由）が受け取る型に、
// Worker 本体を混ぜない。混ざると、契約を参照するだけで Workerd の binding を解決しようとする。
// src/contract.ts と src/app-api.ts の字面を走査して確かめる（実機の起動では測れない性質である）。

/** ソースから import の指定子だけを取り出す */
const specifiersOf = (text: string): readonly string[] =>
  [...text.matchAll(/(?:from|import)\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

/** ソースの import 文（`;` まで）を行頭から取り出す */
const importStatementsOf = (text: string): readonly string[] =>
  [...text.matchAll(/^import[^;]*;/gm)].map((match) => match[0]);

describe("境界（公開する型に Worker 本体を含めない）", () => {
  const source = (name: string): string =>
    node.readFileSync(decodeURIComponent(new URL(`./${name}`, HERE).pathname), "utf8");

  const PUBLIC_SOURCES = ["contract.ts", "app-api.ts"] as const;

  /** 公開面が import してはいけないもの。**型としてでも駄目**（binding の型が漏れる入り口になる） */
  const FORBIDDEN = [
    "cloudflare:workers",
    "@cloudflare/workers-types",
    "@musunest/data-api",
  ] as const;

  /** 型としてだけなら借りてよいもの。**実行時のコードを読み込まないこと**が条件である */
  const TYPE_ONLY = ["@musunest/app-do"] as const;

  /** binding の型の名前。**字面でも出さない**（コメントに書いても、写す人が写してしまう） */
  const BINDING_TYPES = [
    "DataApiEnv",
    "AppInstanceDO",
    "D1Database",
    "R2Bucket",
    "DurableObjectNamespace",
  ] as const;

  it.each(PUBLIC_SOURCES)("%s は Worker 本体も binding の型も import しない", (name) => {
    const text = source(name);
    for (const specifier of specifiersOf(text)) {
      expect(FORBIDDEN as readonly string[], `${name}: ${specifier}`).not.toContain(specifier);
    }
    for (const token of BINDING_TYPES) {
      expect(text, `${name}: ${token}`).not.toContain(token);
    }
  });

  it.each(PUBLIC_SOURCES)("%s が app-do を借りるなら、型としてだけである", (name) => {
    const statements = importStatementsOf(source(name));
    for (const statement of statements) {
      for (const specifier of TYPE_ONLY) {
        if (!statement.includes(`"${specifier}"`)) continue;
        // 実行時の値を import すると、契約を参照するだけで DO（cloudflare:workers）を読み込む
        expect(statement.startsWith("import type"), `${name}: ${statement}`).toBe(true);
      }
    }
  });

  it("Worker の入口（./index）と adapter（./cloudflare）を参照しない", () => {
    // 相対の import は、判定を持つ app-api が入力の検査を読む分だけである
    expect(specifiersOf(source("contract.ts")).filter((s) => s.startsWith("."))).toEqual([]);
    expect(specifiersOf(source("app-api.ts")).filter((s) => s.startsWith("."))).toEqual(["./input.js"]);
  });

  it("パッケージの公開面（package.json の exports）は contract.ts だけである", () => {
    const pkg = JSON.parse(
      node.readFileSync(decodeURIComponent(new URL("../package.json", HERE).pathname), "utf8"),
    ) as { main: string; types: string; exports: Record<string, { default: string }> };
    expect(Object.keys(pkg.exports)).toEqual(["."]);
    expect(pkg.exports["."]?.default).toBe("./dist/contract.js");
    expect(pkg.main).toBe("./dist/contract.js");
    expect(pkg.types).toBe("./dist/contract.d.ts");
  });

  it("契約（contract.ts）は共通の HTTP 契約を appspec-schema から再輸出する", async () => {
    const contracts = (await import("./contract.js")) as Record<string, unknown>;
    for (const name of ["readApiRoute", "apiSpecPath", "apiActionPath", "apiErrorBody"]) {
      expect(typeof contracts[name], name).toBe("function");
    }
    // **一覧は列挙して固定する。** コードとステータスを足すときは、このテストも同じ PR で直す
    // （一覧の外にステータスを隠すと、応答を組む側とこのテストが別々の表を読むことになる）
    expect(contracts["API_ERROR_STATUS"]).toEqual({
      INVALID_JSON: 400,
      INPUT_REJECTED: 422,
      PERMISSION_DENIED: 403,
      NOT_FOUND: 404,
      METHOD_NOT_ALLOWED: 405,
      SPEC_UNAVAILABLE: 503,
      // 参照されているレコードの削除（M1.2）。data-api の failureResponse がここから 409 を引く
      REFERENCE_IN_USE: 409,
    });
    expect(contracts["HEALTHZ_PATH"]).toBe("/healthz");
  });
});
