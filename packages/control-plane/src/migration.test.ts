// D1 マイグレーションの受入試験（#100）。migrations/0002_app_registry.sql を対象にする。
//
//   1. 実 SQLite（node:sqlite）に当て、既存のメタ行が残ること、apps / app_instances の形を確かめる
//   2. 2回目の適用が追加の変更を生まないこと、旧 healthz の問い合わせ（SELECT 1）が成功することを確かめる
//   3. wrangler の適用管理（d1_migrations）を通した経路で、env.dev に --local で全部当たり、
//      2回目は何も当てないことを確かめる（docs/runbook/d1-migration.md §2.1）
//
// ここで当てておかないと、壊れた migration は main へのマージ後に staging の CD（04 §4 ①）で初めて落ちる。
// 適用コマンドは runbook のものをリポジトリ直下からそのまま叩く。違いは2つだけ：
//   - `pnpm exec wrangler` ではなく wrangler の CLI を node で直接起動する
//   - `--persist-to` で一時ディレクトリへ逃がす（開発者の packages/data-api/.wrangler/state に触れない）
//
// wrangler / vitest は devDependencies に無い。ルートの package.json に集約してある（data-api と同じ）。
// node:sqlite・node:fs・node:os・node:child_process は Node 組み込みで、tsconfig の types は
// workers-types だけなので、使う形だけを局所的に書く（動的 import で型解決を避ける）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_INSTANCES_TABLE,
  APPS_TABLE,
  COMMUNITIES_TABLE,
  COMMUNITY_MEMBERSHIPS_TABLE,
  INSTANCE_OWNERS_TABLE,
  USERS_TABLE,
} from "./contract.js";

interface StatementLike {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number };
}
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
}
interface NodeApis {
  DatabaseSync: new (path: string) => DatabaseLike;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  mkdtempSync(prefix: string): string;
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  tmpdir(): string;
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
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const loadNodeApis = async (): Promise<NodeApis> => {
  const [sqlite, fs, os, childProcess] = await Promise.all([
    importUntyped("node:sqlite"),
    importUntyped("node:fs"),
    importUntyped("node:os"),
    importUntyped("node:child_process"),
  ]);
  return {
    DatabaseSync: sqlite.DatabaseSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    mkdtempSync: fs.mkdtempSync,
    rmSync: fs.rmSync,
    tmpdir: os.tmpdir,
    execFileSync: childProcess.execFileSync,
  };
};

const node = await loadNodeApis();
const HERE = (import.meta as ImportMeta & { url: string }).url;
const MIGRATIONS_DIR = decodeURIComponent(new URL("../migrations/", HERE).pathname);
const REPO_ROOT = decodeURIComponent(new URL("../../../", HERE).pathname);
const WRANGLER_CLI = decodeURIComponent(new URL("../../../node_modules/wrangler/bin/wrangler.js", HERE).pathname);
const CONTROL_DB_BINDING = "CONTROL_DB";
const WRANGLER_TIMEOUT_MS = 60_000;

const migrationFiles = (): string[] =>
  node
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

const readMigration = (name: string): string => node.readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8");

const newDatabase = (): DatabaseLike => new node.DatabaseSync(":memory:");

/** 表の列名を、宣言の順に返す（pragma の表関数に束縛引数で表名を渡す）。 */
const columnsOf = (db: DatabaseLike, table: string): string[] =>
  db
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map((row) => String(row["name"]));

/** 行の1列目だけを、行の順に返す（sqlite の行は prototype を持たないので、値へ落として比べる）。 */
const firstColumn = (rows: Record<string, unknown>[]): unknown[] => rows.map((row) => Object.values(row)[0]);

const valuesOf = (db: DatabaseLike, sql: string): unknown[] => firstColumn(db.prepare(sql).all());

describe("migration を実 SQLite に適用する", () => {
  it("ファイル名は <4桁の連番>_<名前>.sql で、0001 から欠番も重複もなく並ぶ", () => {
    // wrangler はファイル名の順に当てる。番号が衝突・前後すると、環境によって当たる順が変わりうる（runbook §1.2）
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((name, index) => {
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(name.slice(0, 4)).toBe(String(index + 1).padStart(4, "0"));
    });
  });

  it("既存のメタ行が残り、apps と app_instances ができる（前方互換規律）", () => {
    const [first, ...rest] = migrationFiles();
    if (first === undefined) throw new Error("migration が1つも無い");

    // 0001 だけ当てた状態でメタ行を入れる。0002 はこれを消さない（表を足すだけ）
    const db = newDatabase();
    db.exec(readMigration(first));
    db.prepare("INSERT INTO _musunest_meta (key, value) VALUES (?, ?)").run("probe", "kept");
    for (const name of rest) db.exec(readMigration(name));

    expect(
      db
        .prepare("SELECT key, value FROM _musunest_meta ORDER BY key")
        .all()
        .map((row) => [row["key"], row["value"]]),
    ).toEqual([["probe", "kept"]]);

    expect(valuesOf(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual(
      expect.arrayContaining(["apps", "app_instances", "_musunest_meta"]),
    );
    expect(columnsOf(db, APPS_TABLE)).toEqual([
      "source_sha256",
      "schema_version",
      "source_key",
      "normalized_key",
      "created_at",
    ]);
    expect(columnsOf(db, APP_INSTANCES_TABLE)).toEqual(["instance_id", "source_sha256", "created_at"]);
  });

  it("2回目の適用は追加の変更を生まず、既存の行も残る（CREATE TABLE IF NOT EXISTS）", () => {
    const db = newDatabase();
    for (const name of migrationFiles()) db.exec(readMigration(name));
    db.prepare("INSERT INTO _musunest_meta (key, value) VALUES (?, ?)").run("before", "kept");
    db.prepare(
      "INSERT INTO apps (source_sha256, schema_version, source_key, normalized_key) VALUES (?, ?, ?, ?)",
    ).run("a".repeat(64), "community.app-spec/v0.2", "s/app.spec.yaml", "n/normalized.json");

    for (const name of migrationFiles()) db.exec(readMigration(name));

    expect(valuesOf(db, "SELECT value FROM _musunest_meta WHERE key = 'before'")).toEqual(["kept"]);
    expect(valuesOf(db, "SELECT COUNT(*) FROM apps")).toEqual([1]);
    expect(valuesOf(db, "SELECT COUNT(*) FROM app_instances")).toEqual([0]);
  });

  it("0003 は表を足すだけで、既存の apps と app_instances を変えない（identity の 4 表）", () => {
    // identity の migration（#259）は 0003 の1つだけ
    const identityMigrations = migrationFiles().filter((name) => name.startsWith("0003_"));
    expect(identityMigrations).toHaveLength(1);
    const before = migrationFiles().filter((name) => !name.startsWith("0003_"));

    // 0002 まで当てて、既存の表に形と行を作る
    const db = newDatabase();
    for (const name of before) db.exec(readMigration(name));
    const appsColumns = columnsOf(db, APPS_TABLE);
    const instancesColumns = columnsOf(db, APP_INSTANCES_TABLE);
    const sha = "a".repeat(64);
    db.prepare("INSERT INTO apps (source_sha256, schema_version, source_key, normalized_key) VALUES (?, ?, ?, ?)").run(
      sha,
      "community.app-spec/v0.2",
      `specs/${sha}/app.spec.yaml`,
      `specs/${sha}/normalized.json`,
    );
    db.prepare("INSERT INTO app_instances (instance_id, source_sha256) VALUES (?, ?)").run("inst-1", sha);

    for (const name of identityMigrations) db.exec(readMigration(name));

    // 既存の表は形も行も変わらない（列を足していない。前のコードがそのまま動く）
    expect(columnsOf(db, APPS_TABLE)).toEqual(appsColumns);
    expect(columnsOf(db, APP_INSTANCES_TABLE)).toEqual(instancesColumns);
    expect(valuesOf(db, "SELECT source_sha256 FROM apps")).toEqual([sha]);
    expect(valuesOf(db, "SELECT instance_id FROM app_instances")).toEqual(["inst-1"]);

    // identity の 4 表が、期待する列でできる（前方互換規律：表を足すだけ）
    expect(columnsOf(db, USERS_TABLE)).toEqual(["user_id", "google_subject", "display_name", "created_at"]);
    expect(columnsOf(db, COMMUNITIES_TABLE)).toEqual(["community_id", "name", "owner_user_id", "created_at"]);
    expect(columnsOf(db, COMMUNITY_MEMBERSHIPS_TABLE)).toEqual(["community_id", "user_id", "role", "created_at"]);
    expect(columnsOf(db, INSTANCE_OWNERS_TABLE)).toEqual(["instance_id", "community_id", "created_at"]);
  });

  it("旧 healthz の問い合わせ（SELECT 1）が成功する", () => {
    // data-api の healthz は CONTROL_DB へ `SELECT 1` しか打たない（packages/data-api/src/cloudflare.ts）。
    // 表を足した後も、その1文が通ることを確かめる
    const db = newDatabase();
    for (const name of migrationFiles()) db.exec(readMigration(name));
    expect(valuesOf(db, "SELECT 1")).toEqual([1]);
  });
});

describe("migration の適用管理を通した再適用（wrangler d1 migrations・env.dev --local）", () => {
  let persistTo = "";

  /** runbook §2.1 の `--env dev --config packages/data-api/wrangler.jsonc --local` に `--persist-to` を足したもの */
  const devLocal = (): string[] => [
    "--env",
    "dev",
    "--config",
    "packages/data-api/wrangler.jsonc",
    "--local",
    "--persist-to",
    persistTo,
  ];

  const wrangler = (...args: string[]): string =>
    node.execFileSync(process.execPath, [WRANGLER_CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      encoding: "utf8",
      // stdin を渡さない＝非対話。確認は既定値（yes）で進む。CD のランナーと同じ条件
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WRANGLER_TIMEOUT_MS,
    });

  const query = (sql: string): Record<string, unknown>[] => {
    const out = wrangler("d1", "execute", CONTROL_DB_BINDING, ...devLocal(), "--json", "--command", sql);
    const [result] = JSON.parse(out) as [{ results: Record<string, unknown>[] }];
    return result?.results ?? [];
  };

  beforeAll(() => {
    persistTo = node.mkdtempSync(`${node.tmpdir()}/musunest-control-plane-d1-`);
    // 2回当てる。CD は main への push のたびに当てるので、2回目が何も当てないことまでが契約
    wrangler("d1", "migrations", "apply", CONTROL_DB_BINDING, ...devLocal());
    wrangler("d1", "migrations", "apply", CONTROL_DB_BINDING, ...devLocal());
  }, WRANGLER_TIMEOUT_MS * 2);

  afterAll(() => {
    if (persistTo !== "") node.rmSync(persistTo, { recursive: true, force: true });
  });

  it("1回目で全部当たり、2回目は追加の適用が無い（d1_migrations にファイルごとに1件）", () => {
    expect(firstColumn(query("SELECT name FROM d1_migrations ORDER BY id"))).toEqual(migrationFiles());
  });

  it("apps・app_instances・identity の 4 表ができ、旧 healthz の問い合わせ（SELECT 1）も成功する", () => {
    expect(
      firstColumn(
        query(
          "SELECT name FROM sqlite_master WHERE type = 'table'" +
            " AND name IN ('apps', 'app_instances', 'users', 'communities', 'community_memberships', 'instance_owners')" +
            " ORDER BY name",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        APPS_TABLE,
        APP_INSTANCES_TABLE,
        USERS_TABLE,
        COMMUNITIES_TABLE,
        COMMUNITY_MEMBERSHIPS_TABLE,
        INSTANCE_OWNERS_TABLE,
      ]),
    );
    expect(firstColumn(query("SELECT 1 AS x"))).toEqual([1]);
  });
});
