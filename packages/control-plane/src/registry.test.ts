// 登録表の読み書きの unit（#100）。**本物の SQLite を実行者にして**、束縛引数と失敗の伝播まで見る。
//
// 実行者は test の内側で node:sqlite に繋ぐ。data-api の Cloudflare adapter が D1Database を
// RegistryExecutor に包むのと同じ形（query / execute / batch）で、SQL は migrations/ の現物を当てる。
// モックにしないのは、SQL と引数の束縛が「動く」ことの証明は、実際に SQL を走らせることでしか
// 得られないからである（data-api の index.test.ts と同じ考え方）。
//
// node:sqlite と node:fs は devDependencies ではなく Node 組み込みで、tsconfig の types は
// workers-types だけなので、使う形だけを局所的に書く（動的 import で型解決を避ける）。
import { describe, expect, it } from "vitest";
import {
  APP_INSTANCES_TABLE,
  APPS_TABLE,
  type RegistryExecutor,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from "./contract.js";
import { getApp, getInstance, registerApp, registerInstance, replaceInstance, resolveInstanceApp } from "./registry.js";

// ── Node 組み込みの最小の形（src は workerd 向けなので、型はここだけに書く）──────

interface StatementLike {
  all(...params: SqlValue[]): SqlRow[];
  run(...params: SqlValue[]): { changes: number };
}
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseLike;
}
interface FsModule {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const [{ DatabaseSync }, { readFileSync, readdirSync }] = (await Promise.all([
  importUntyped("node:sqlite"),
  importUntyped("node:fs"),
])) as [SqliteModule, FsModule];

const HERE = (import.meta as ImportMeta & { url: string }).url;
const MIGRATIONS_DIR = decodeURIComponent(new URL("../migrations/", HERE).pathname);

// ── 実行者：本物の SQLite を RegistryExecutor の形で包む ────────────────────

class SqliteExecutor implements RegistryExecutor {
  /** 渡された束縛引数を、文の順に記録する（SQL へ埋め込んでいないことの検査に使う） */
  readonly bound: SqlValue[][] = [];
  readonly statements: string[] = [];

  constructor(private readonly db: DatabaseLike) {}

  async query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]> {
    return this.run(statement).rows as readonly Row[];
  }

  async execute(statement: SqlStatement): Promise<number> {
    return this.run(statement).changes;
  }

  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    // D1 の batch は1トランザクション。途中の失敗は全部戻す（部分適用を残さない）
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => this.run(statement));
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private run(statement: SqlStatement): SqlResult {
    const params = [...(statement.params ?? [])];
    this.bound.push(params);
    this.statements.push(statement.sql);
    const prepared = this.db.prepare(statement.sql);
    // 読み取りは rows、書き込みは changes。SQL の先頭で見分ける（このテストが使う文だけ）
    if (/^\s*(SELECT|WITH)\b/i.test(statement.sql)) {
      return { rows: prepared.all(...params), changes: 0 };
    }
    return { rows: [], changes: prepared.run(...params).changes };
  }
}

const newRegistry = (): { executor: SqliteExecutor } => {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) db.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
  return { executor: new SqliteExecutor(db) };
};

const countRows = async (executor: RegistryExecutor, table: string): Promise<number> => {
  const rows = await executor.query<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
  return rows[0]?.n ?? -1;
};

// ── 入力 ────────────────────────────────────────────────────────────

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const APP_A = {
  sourceSha256: SHA_A,
  schemaVersion: "community.app-spec/v0.2",
  sourceKey: `specs/${SHA_A}/app.spec.yaml`,
  normalizedKey: `specs/${SHA_A}/normalized.json`,
};
const APP_B = {
  sourceSha256: SHA_B,
  schemaVersion: "community.app-spec/v0.2",
  sourceKey: `specs/${SHA_B}/app.spec.yaml`,
  normalizedKey: `specs/${SHA_B}/normalized.json`,
};
const INSTANCE_1 = { instanceId: "inst-1", sourceSha256: SHA_A };

describe("登録の読み書き（本物の SQLite）", () => {
  it("空の登録への読取は null（例外にしない）", async () => {
    const { executor } = newRegistry();
    expect(await getApp(executor, SHA_A)).toBeNull();
    expect(await getInstance(executor, INSTANCE_1.instanceId)).toBeNull();
    expect(await resolveInstanceApp(executor, INSTANCE_1.instanceId)).toBeNull();
  });

  it("原本 SHA・版・2つの R2 キーを登録すると、SHA から同じ値を取得できる", async () => {
    const { executor } = newRegistry();
    const registered = await registerApp(executor, APP_A);

    expect(registered).toEqual({ ...APP_A, createdAt: expect.any(String) });
    expect(registered.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(await getApp(executor, SHA_A)).toEqual(registered);
    expect(await getApp(executor, SHA_B)).toBeNull();
    expect(await countRows(executor, APPS_TABLE)).toBe(1);
  });

  it("インスタンス ID から同じ値を取得でき、インスタンスからアプリを解決できる", async () => {
    const { executor } = newRegistry();
    const app = await registerApp(executor, APP_A);
    const instance = await registerInstance(executor, INSTANCE_1);

    expect(instance).toEqual({ ...INSTANCE_1, createdAt: expect.any(String) });
    expect(await getInstance(executor, INSTANCE_1.instanceId)).toEqual(instance);
    expect(await resolveInstanceApp(executor, INSTANCE_1.instanceId)).toEqual(app);
    expect(await resolveInstanceApp(executor, "inst-unknown")).toBeNull();
  });

  it("同一内容を2回登録しても、アプリ・インスタンスの件数は増えない", async () => {
    const { executor } = newRegistry();
    await registerApp(executor, APP_A);
    await registerApp(executor, APP_A);
    await registerInstance(executor, INSTANCE_1);
    await registerInstance(executor, INSTANCE_1);

    expect(await countRows(executor, APPS_TABLE)).toBe(1);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });

  it("同じ SHA-256 で内容の違う登録は app_conflict で失敗し、元の行が変わらない", async () => {
    const { executor } = newRegistry();
    const original = await registerApp(executor, APP_A);

    await expect(registerApp(executor, { ...APP_A, normalizedKey: "other/normalized.json" })).rejects.toMatchObject({
      name: "RegistryError",
      code: "app_conflict",
    });
    expect(await getApp(executor, SHA_A)).toEqual(original);
    expect(await countRows(executor, APPS_TABLE)).toBe(1);
  });

  it("存在しないアプリを指すインスタンスの登録は app_not_found で失敗し、行が入らない", async () => {
    const { executor } = newRegistry();
    await expect(registerInstance(executor, INSTANCE_1)).rejects.toMatchObject({
      name: "RegistryError",
      code: "app_not_found",
    });
    expect(await getInstance(executor, INSTANCE_1.instanceId)).toBeNull();
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(0);
  });

  it("同じ ID で参照先の違う登録は instance_conflict で失敗し、元の行が変わらない", async () => {
    const { executor } = newRegistry();
    await registerApp(executor, APP_A);
    await registerApp(executor, APP_B);
    const original = await registerInstance(executor, INSTANCE_1);

    await expect(registerInstance(executor, { instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B })).rejects.toMatchObject({
      name: "RegistryError",
      code: "instance_conflict",
    });
    expect(await getInstance(executor, INSTANCE_1.instanceId)).toEqual(original);
  });

  it("差し替え（#175）：前の参照と一致する行だけを書き換える。apps は増え、app_instances は 1 行のまま", async () => {
    const { executor } = newRegistry();
    const first = await registerApp(executor, APP_A);
    const next = await registerApp(executor, APP_B);
    const before = await registerInstance(executor, INSTANCE_1);

    const replaced = await replaceInstance(executor, { instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B }, SHA_A);

    // 行の中身が変わるのは指し先だけである（created_at は登録したときのまま）
    expect(replaced).toEqual({ instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B, createdAt: before.createdAt });
    expect(await getInstance(executor, INSTANCE_1.instanceId)).toEqual(replaced);
    expect(await resolveInstanceApp(executor, INSTANCE_1.instanceId)).toEqual(next);
    // 前のアプリの行は残る（巻き戻すときの材料）
    expect(await getApp(executor, SHA_A)).toEqual(first);
    expect(await countRows(executor, APPS_TABLE)).toBe(2);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });

  it("差し替え（#175）：既に差し替え先を指していれば成功する（同じ入力の再実行・別の deploy が同じ結果にしたとき）", async () => {
    const { executor } = newRegistry();
    await registerApp(executor, APP_A);
    await registerApp(executor, APP_B);
    await registerInstance(executor, INSTANCE_1);
    await replaceInstance(executor, { instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B }, SHA_A);

    const again = await replaceInstance(executor, { instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B }, SHA_A);

    expect(again.sourceSha256).toBe(SHA_B);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });

  it("差し替え（#175）：期待した前の参照と違えば instance_conflict になり、行は変えない（同時に publish したとき）", async () => {
    const { executor } = newRegistry();
    await registerApp(executor, APP_A);
    await registerApp(executor, APP_B);
    const original = await registerInstance(executor, INSTANCE_1);

    // 別の deploy が先に差し替えた形（期待する前の参照が、いまの行と違う）
    await expect(
      replaceInstance(executor, { instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B }, "c".repeat(64)),
    ).rejects.toMatchObject({ name: "RegistryError", code: "instance_conflict" });

    expect(await getInstance(executor, INSTANCE_1.instanceId)).toEqual(original);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });

  it("差し替え（#175）：差し替え先のアプリが未登録なら app_not_found になり、行は変えない", async () => {
    const { executor } = newRegistry();
    await registerApp(executor, APP_A);
    const original = await registerInstance(executor, INSTANCE_1);

    await expect(
      replaceInstance(executor, { instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B }, SHA_A),
    ).rejects.toMatchObject({ name: "RegistryError", code: "app_not_found" });

    expect(await getInstance(executor, INSTANCE_1.instanceId)).toEqual(original);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });

  it("差し替え（#175）：差し替えるインスタンスが無ければ instance_conflict になり、行を作らない", async () => {
    const { executor } = newRegistry();
    await registerApp(executor, APP_B);

    await expect(
      replaceInstance(executor, { instanceId: INSTANCE_1.instanceId, sourceSha256: SHA_B }, SHA_A),
    ).rejects.toMatchObject({ name: "RegistryError", code: "instance_conflict" });

    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(0);
  });

  it("値は SQL へ埋め込まず、束縛引数として渡す（引用符を含む ID でも表は壊れない）", async () => {
    const { executor } = newRegistry();
    await registerApp(executor, APP_A);
    await getApp(executor, SHA_A);

    expect(executor.bound).toContainEqual([SHA_A, APP_A.schemaVersion, APP_A.sourceKey, APP_A.normalizedKey]);
    expect(executor.bound).toContainEqual([SHA_A]);
    expect(executor.statements.every((sql) => !sql.includes(SHA_A))).toBe(true);

    // 文字列として SQL へ埋め込んでいたら表が消える値。束縛引数ならそのままの ID として残る
    const hostile = "i'; DROP TABLE apps; --";
    await registerInstance(executor, { instanceId: hostile, sourceSha256: SHA_A });
    expect((await getInstance(executor, hostile))?.instanceId).toBe(hostile);
    expect(await countRows(executor, APPS_TABLE)).toBe(1);
  });

  it("実行者が失敗したら、その失敗がそのまま伝播する", async () => {
    const failure = new Error("D1 unavailable");
    const failing: RegistryExecutor = {
      query: async () => {
        throw failure;
      },
      execute: async () => {
        throw failure;
      },
      batch: async () => {
        throw failure;
      },
    };

    await expect(getApp(failing, SHA_A)).rejects.toBe(failure);
    await expect(getInstance(failing, INSTANCE_1.instanceId)).rejects.toBe(failure);
    await expect(registerApp(failing, APP_A)).rejects.toBe(failure);
    await expect(registerInstance(failing, INSTANCE_1)).rejects.toBe(failure);
    await expect(replaceInstance(failing, INSTANCE_1, SHA_A)).rejects.toBe(failure);
  });
});
