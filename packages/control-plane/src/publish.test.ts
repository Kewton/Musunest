// publish の中身の受入試験（#101）。**本物の SQLite を実行者にして**、R2 への書き込みと D1 の登録まで見る。
//
//   1. 既存の負例（samples/negatives）を全部 publish に渡すと、#97（checkSpec）と同じ診断が返り、
//      R2 書き込みも D1 の呼び出しも 0 回である（受入条件 1）
//   2. 正例は原本と正規化した JSON の 2 個を同じ SHA に結び付け、登録から読み戻して一致する（受入条件 2）
//   3. 同じ入力の 2 回で行が増えず内容も同じ。別インスタンスでは1行増え、既存インスタンスへ別 SHA は
//      競合になり元の参照を保つ（受入条件 3）
//   4. R2 の 1 個目・2 個目・D1 の各段に失敗を差し込むと成功を返さず、後ろの段を行わない。
//      同じ入力の再実行で正しい状態へ到達する（受入条件 4）
//
// 実行は test の内側で node:sqlite に繋ぐ（registry.test.ts と同じ形）。R2 は記録するだけの偽物にする。
// node:sqlite と node:fs は Node 組み込みで、tsconfig の types は workers-types だけなので、
// 使う形だけを局所的に書く（動的 import で型解決を避ける）。
import { describe, expect, it } from "vitest";
import { readNegativeIndex } from "@musunest/appspec-schema";
import { negativeIndexFile, negativeSpecFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import type { AppSpec } from "@musunest/appspec-schema";
import { checkSpec, normalizeSpec } from "@musunest/spec-engine";
import {
  APP_INSTANCES_TABLE,
  APPS_TABLE,
  type RegistryExecutor,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from "./contract.js";
import { getApp, getInstance, resolveInstanceApp } from "./registry.js";
import {
  publishSpec,
  isReplaceableDeclaration,
  normalizedObjectKey,
  sourceObjectKey,
  type PublishResult,
  type SpecReader,
  type SpecWriter,
} from "./publish.js";

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
  readFileSync(path: string | URL, encoding: "utf8"): string;
  readdirSync(path: string): string[];
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const [{ DatabaseSync }, { readFileSync, readdirSync }] = (await Promise.all([
  importUntyped("node:sqlite"),
  importUntyped("node:fs"),
])) as [SqliteModule, FsModule];

const HERE = (import.meta as ImportMeta & { url: string }).url;
const MIGRATIONS_DIR = decodeURIComponent(new URL("../migrations/", HERE).pathname);

// ── 実行者：本物の SQLite を RegistryExecutor の形で包む（registry.test.ts と同じ）──────

class SqliteExecutor implements RegistryExecutor {
  /** 渡された文（呼び出しの有無を確かめるのに使う） */
  readonly statements: string[] = [];

  constructor(private readonly db: DatabaseLike) {}

  async query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]> {
    return this.run(statement).rows as readonly Row[];
  }

  async execute(statement: SqlStatement): Promise<number> {
    return this.run(statement).changes;
  }

  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    // D1 の batch は1トランザクション。途中の失敗は全部戻す
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
    this.statements.push(statement.sql);
    const prepared = this.db.prepare(statement.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(statement.sql)) {
      return { rows: prepared.all(...(statement.params ?? [])), changes: 0 };
    }
    return { rows: [], changes: prepared.run(...(statement.params ?? [])).changes };
  }
}

/** batch を1回だけ失敗させる実行者（失敗の差し込みと、再実行での復旧に使う）。 */
class FlakyExecutor implements RegistryExecutor {
  #batches = 0;

  constructor(
    private readonly inner: RegistryExecutor,
    private readonly failAtBatch: number,
  ) {}

  async query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]> {
    return this.inner.query<Row>(statement);
  }

  async execute(statement: SqlStatement): Promise<number> {
    return this.inner.execute(statement);
  }

  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    this.#batches += 1;
    if (this.#batches === this.failAtBatch) {
      throw new Error("D1 unavailable（値は出さない）");
    }
    return this.inner.batch(statements);
  }
}

/** R2 の偽物。書けたものを記録し、n 回目の書き込みだけ失敗させられる。読み（#175 の差し替え）もできる。 */
class RecordingSpecWriter implements SpecWriter, SpecReader {
  readonly writes: { key: string; body: string }[] = [];
  /** 置いてあるオブジェクト（キー → 本文）。`read` はここから返す（R2 の GET の代わり） */
  readonly objects = new Map<string, string>();
  #calls = 0;

  constructor(private readonly failAt = 0) {}

  async write(key: string, body: string): Promise<void> {
    this.#calls += 1;
    if (this.#calls === this.failAt) throw new Error("R2 unavailable（値は出さない）");
    this.writes.push({ key, body });
    this.objects.set(key, body);
  }

  async read(key: string): Promise<unknown> {
    const body = this.objects.get(key);
    if (body === undefined) throw new Error("R2 に無い（値は出さない）");
    return JSON.parse(body) as unknown;
  }
}

interface Registry {
  readonly db: DatabaseLike;
  readonly executor: SqliteExecutor;
}

const newRegistry = (): Registry => {
  const db = new DatabaseSync(":memory:");
  // oxlint-disable-next-line unicorn/no-array-sort -- registry.test.ts と同じ形（ES2022 の lib に toSorted が無い）
  for (const name of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
  }
  return { db, executor: new SqliteExecutor(db) };
};

const countRows = async (executor: RegistryExecutor, table: string): Promise<number> => {
  const rows = await executor.query<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
  return rows[0]?.n ?? -1;
};

const read = (file: URL): string => readFileSync(file, "utf8");

const SAMPLE = read(sampleSpecFile("expense-log"));
const INSTANCE = "e2e-expense-log";

const expectRejected = (result: PublishResult): Extract<PublishResult, { ok: false }> => {
  if (result.ok) throw new Error("publish が成功した（失敗を期待した）");
  return result;
};

// ── 1. 負例 ─────────────────────────────────────────────────────────

describe("負例は #97 と同じ診断で止まり、R2 にも D1 にも触らない", () => {
  const index = readNegativeIndex(JSON.parse(read(negativeIndexFile())));

  it("負例の一覧が空でない（受入試験が空回りしていない）", () => {
    expect(index.negatives.length).toBeGreaterThanOrEqual(24);
  });

  it.each(index.negatives.map((n) => n.name))("%s", async (name) => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    const source = read(negativeSpecFile(name));

    const result = expectRejected(await publishSpec({ specs, registry: executor }, { source, instanceId: INSTANCE }));

    // #97 と同じ診断（同じ並び・同じ中身）
    const checked = checkSpec(source);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(result.failure.stage).toBe("check");
    expect(result.failure.code).toBeNull();
    expect(result.failure.diagnostics).toEqual(checked.diagnostics);

    // R2 書き込みも D1 の呼び出しも 0 回
    expect(specs.writes).toEqual([]);
    expect(executor.statements).toEqual([]);
    expect(await countRows(executor, APPS_TABLE)).toBe(0);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(0);
  });
});

// ── 2. 正例 ─────────────────────────────────────────────────────────

describe("正例は原本と正規化した JSON の 2 個を同じ SHA に結び付ける", () => {
  it("2 個のオブジェクトを決定的なキーへ置き、登録から読み戻した SHA と版が一致する", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();

    const result = await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: INSTANCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = await normalizeSpec(SAMPLE);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const sha = normalized.app.sourceSha256;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(result.app.sourceSha256).toBe(sha);
    expect(result.instance).toEqual({ instanceId: INSTANCE, sourceSha256: sha, createdAt: expect.any(String) });

    // R2 の 2 個（原本は受け取ったバイト列のまま、JSON は #98 のバイト列のまま）
    expect(specs.writes).toEqual([
      { key: `specs/${sha}/app.spec.yaml`, body: SAMPLE },
      { key: `specs/${sha}/normalized.json`, body: normalized.json },
    ]);
    expect(sourceObjectKey(sha)).toBe(`specs/${sha}/app.spec.yaml`);
    expect(normalizedObjectKey(sha)).toBe(`specs/${sha}/normalized.json`);

    // 登録から読み戻す（#100 の読み取り）
    const app = await getApp(executor, sha);
    expect(app).toEqual(result.app);
    expect(app?.sourceKey).toBe(sourceObjectKey(sha));
    expect(app?.normalizedKey).toBe(normalizedObjectKey(sha));
    expect(app?.schemaVersion).toBe("community.app-spec/v0.2-draft");

    // #102 の取得契約と同じ手順：登録の normalized_key を R2（ここでは記録）から読み、SHA を突き合わせる
    const storedJson = specs.writes.find((w) => w.key === app?.normalizedKey)?.body ?? "";
    const parsed = JSON.parse(storedJson) as { sourceSha256: string; schemaVersion: string };
    expect(parsed.sourceSha256).toBe(sha);
    expect(parsed.schemaVersion).toBe("community.app-spec/v0.2-draft");

    // インスタンスからアプリを解決できる
    expect(await resolveInstanceApp(executor, INSTANCE)).toEqual(result.app);
  });
});

// ── 3. 冪等・共有・競合 ─────────────────────────────────────────────

describe("同じ入力の再実行と、別インスタンス・別 SHA", () => {
  it("同じ入力の 2 回は、行が増えず、最終の内容も同じ", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();

    const first = await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: INSTANCE });
    const second = await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: INSTANCE });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.app).toEqual(first.app);
    expect(second.instance).toEqual(first.instance);
    expect(await countRows(executor, APPS_TABLE)).toBe(1);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
    // R2 へは 2 回とも同じ内容を上書きする
    expect(specs.writes.length).toBe(4);
    expect(specs.writes[0]).toEqual(specs.writes[2]);
    expect(specs.writes[1]).toEqual(specs.writes[3]);
  });

  it("同じ原本を別インスタンスへ登録すると、アプリは共有され、インスタンスだけ 1 行増える", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();

    const first = await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: "inst-a" });
    const second = await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: "inst-b" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.app).toEqual(first.app);
    expect(await countRows(executor, APPS_TABLE)).toBe(1);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(2);
  });

  it("既存インスタンスへ別 SHA を渡すと instance_conflict になり、元の参照を保つ", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    // 原本の 1 行だけを変えた別の宣言（SHA が変わる）
    const other = `${SAMPLE}\n`;

    const first = await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: INSTANCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const conflict = expectRejected(await publishSpec({ specs, registry: executor }, { source: other, instanceId: INSTANCE }));
    expect(conflict.failure.stage).toBe("instance");
    expect(conflict.failure.code).toBe("instance_conflict");

    // 元の参照を保つ（既存行は書き換えない）
    expect(await getInstance(executor, INSTANCE)).toEqual(first.instance);
    expect(await resolveInstanceApp(executor, INSTANCE)).toEqual(first.app);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });
});

// ── 4. 失敗の差し込みと再実行 ────────────────────────────────────────

describe("各段の失敗は成功を返さず、後ろの段を行わない。再実行で正しい状態へ到達する", () => {
  it("R2 の 1 個目で失敗：2 個目も D1 も行わず、行も入らない", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter(1);

    const failed = expectRejected(await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: INSTANCE }));
    expect(failed.failure.stage).toBe("source");
    expect(specs.writes).toEqual([]);
    expect(executor.statements).toEqual([]);
  });

  it("R2 の 2 個目で失敗：原本だけ置かれ、D1 は行わない", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter(2);
    const normalized = await normalizeSpec(SAMPLE);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const failed = expectRejected(await publishSpec({ specs, registry: executor }, { source: SAMPLE, instanceId: INSTANCE }));
    expect(failed.failure.stage).toBe("normalized");
    expect(specs.writes).toEqual([{ key: sourceObjectKey(normalized.app.sourceSha256), body: SAMPLE }]);
    expect(executor.statements).toEqual([]);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(0);
  });

  it("D1 のアプリ登録で失敗：インスタンスを登録しない", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    const flaky = new FlakyExecutor(executor, 1);

    const failed = expectRejected(await publishSpec({ specs, registry: flaky }, { source: SAMPLE, instanceId: INSTANCE }));
    expect(failed.failure.stage).toBe("app");
    expect(failed.failure.code).toBeNull();
    expect(await countRows(executor, APPS_TABLE)).toBe(0);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(0);
  });

  it("D1 のインスタンス登録で失敗：アプリは残るが、インスタンスは増えない", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    const flaky = new FlakyExecutor(executor, 2);

    const failed = expectRejected(await publishSpec({ specs, registry: flaky }, { source: SAMPLE, instanceId: INSTANCE }));
    expect(failed.failure.stage).toBe("instance");
    expect(await countRows(executor, APPS_TABLE)).toBe(1);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(0);
  });

  const RETRIES: readonly {
    readonly name: string;
    readonly specs: (failAt: number) => RecordingSpecWriter;
    readonly registry: (inner: RegistryExecutor) => RegistryExecutor;
  }[] = [
    { name: "R2 の 1 個目", specs: (failAt) => new RecordingSpecWriter(failAt), registry: (inner) => inner },
    { name: "R2 の 2 個目", specs: (failAt) => new RecordingSpecWriter(failAt + 1), registry: (inner) => inner },
    { name: "D1 のアプリ", specs: () => new RecordingSpecWriter(), registry: (inner) => new FlakyExecutor(inner, 1) },
    { name: "D1 のインスタンス", specs: () => new RecordingSpecWriter(), registry: (inner) => new FlakyExecutor(inner, 2) },
  ];

  it.each(RETRIES.map((r) => r.name))("%s で失敗したあと、同じ入力の再実行で正しい状態へ到達する", async (name) => {
    const spec = RETRIES.find((r) => r.name === name);
    if (spec === undefined) throw new Error(`${name} が無い`);
    const { executor } = newRegistry();
    const specs = spec.specs(1);
    const registry = spec.registry(executor);

    const failed = await publishSpec({ specs, registry }, { source: SAMPLE, instanceId: INSTANCE });
    expect(failed.ok).toBe(false);

    const retried = await publishSpec({ specs, registry }, { source: SAMPLE, instanceId: INSTANCE });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;

    expect(await countRows(executor, APPS_TABLE)).toBe(1);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
    expect(await resolveInstanceApp(executor, INSTANCE)).toEqual(retried.app);
    // R2 には 2 個（同じキーへの上書きなので、キーは 2 つだけ）
    expect(new Set(specs.writes.map((w) => w.key)).size).toBe(2);
  });
});

// ── 5. はっきり差し替える（--replace・#175）──────────────────────────
//
//   1. 差し替えてよい宣言（項目を足す）なら通り、登録簿の行が新しい原本の SHA-256 を指す
//   2. 差し替えてよい宣言でなければ replacement_conflict で断り、**登録簿の行も R2 も変えない**
//   3. 差し替えない（`replace` なし）既定の挙動は instance_conflict のまま（上の describe が見る）
//   4. 前の原本の正規化した JSON を読めなければ断る

/** 差し替えの試験に使う、entity が 1 つの最小の宣言（検査に通る） */
const BASE_DECLARATION = [
  "entities:",
  "  - name: task",
  "    fields:",
  "      title: string",
  "      done: string",
  "views: []",
  "actions: []",
  "validations: []",
  "computed: []",
  "permissions: []",
  "minIdentity:",
  "  mode: anonymous",
  "",
].join("\n");
/** 項目を足した宣言（差し替えてよい） */
const ADDED_FIELD = BASE_DECLARATION.replace("      done: string\n", "      done: string\n      memo: string\n");
/** 一覧（UI 層）を足した宣言（データ層が変わらないので、差し替えてよい） */
const ADDED_VIEW = BASE_DECLARATION.replace(
  "views: []",
  ["views:", "  - name: taskList", "    entity: task", "    type: table", "    show: [title, done]"].join("\n"),
);
/** 項目を消した宣言（差し替えてはならない） */
const REMOVED_FIELD = BASE_DECLARATION.replace("      done: string\n", "");
/** 型を変えた宣言（差し替えてはならない） */
const RETYPED_FIELD = BASE_DECLARATION.replace("      done: string", "      done: number");
/** entity の名前を変えた宣言（差し替えてはならない） */
const RENAMED_ENTITY = BASE_DECLARATION.replace("  - name: task", "  - name: todo");

describe("はっきり差し替える（--replace・#175）", () => {
  it("項目を足す差し替えは通り、登録簿の行が新しい原本の SHA-256 を指す", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();

    const first = await publishSpec({ specs, registry: executor }, { source: BASE_DECLARATION, instanceId: INSTANCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replaced = await publishSpec(
      { specs, registry: executor, readSpec: specs },
      { source: ADDED_FIELD, instanceId: INSTANCE, replace: true },
    );
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    if (!replaced.ok) return;

    // 登録簿の行は新しい原本を指し、前の原本の SHA-256 が結果に残る（受入条件）
    expect(replaced.app.sourceSha256).not.toBe(first.app.sourceSha256);
    expect(replaced.replacedSourceSha256).toBe(first.app.sourceSha256);
    expect(replaced.instance).toEqual({ instanceId: INSTANCE, sourceSha256: replaced.app.sourceSha256, createdAt: first.instance.createdAt });
    expect(await getInstance(executor, INSTANCE)).toEqual(replaced.instance);
    expect(await resolveInstanceApp(executor, INSTANCE)).toEqual(replaced.app);
    // 前のアプリの行は残る（巻き戻すときの材料）
    expect(await getApp(executor, first.app.sourceSha256)).toEqual(first.app);
    expect(await countRows(executor, APPS_TABLE)).toBe(2);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);

    // 差し替えたあとに同じ原本をもう一度置いても落ちない（2 回目は差し替えではない）
    const again = await publishSpec(
      { specs, registry: executor, readSpec: specs },
      { source: ADDED_FIELD, instanceId: INSTANCE, replace: true },
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.replacedSourceSha256).toBeNull();
    expect(again.instance).toEqual(replaced.instance);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });

  it("データ層が変わらない差し替え（一覧を足す）も通る", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    const first = await publishSpec({ specs, registry: executor }, { source: BASE_DECLARATION, instanceId: INSTANCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replaced = await publishSpec(
      { specs, registry: executor, readSpec: specs },
      { source: ADDED_VIEW, instanceId: INSTANCE, replace: true },
    );
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.replacedSourceSha256).toBe(first.app.sourceSha256);
  });

  it.each([
    ["項目を消す", REMOVED_FIELD],
    ["型を変える", RETYPED_FIELD],
    ["entity の名前を変える", RENAMED_ENTITY],
  ])("%s 差し替えは replacement_conflict で断り、登録簿の行も R2 も変えない", async (_, source) => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    const first = await publishSpec({ specs, registry: executor }, { source: BASE_DECLARATION, instanceId: INSTANCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const writesBefore = specs.writes.length;

    const refused = expectRejected(
      await publishSpec({ specs, registry: executor, readSpec: specs }, { source, instanceId: INSTANCE, replace: true }),
    );

    expect(refused.failure.stage).toBe("instance");
    expect(refused.failure.code).toBe("replacement_conflict");
    // 断ると分かった時点で止める（R2 へも D1 へも書かない）
    expect(specs.writes.length).toBe(writesBefore);
    expect(await getInstance(executor, INSTANCE)).toEqual(first.instance);
    expect(await resolveInstanceApp(executor, INSTANCE)).toEqual(first.app);
    expect(await countRows(executor, APPS_TABLE)).toBe(1);
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });

  it("前の原本を読む口が無ければ断る（R2 にも D1 にも書かない）", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    const first = await publishSpec({ specs, registry: executor }, { source: BASE_DECLARATION, instanceId: INSTANCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const writesBefore = specs.writes.length;

    const refused = expectRejected(
      await publishSpec({ specs, registry: executor }, { source: ADDED_FIELD, instanceId: INSTANCE, replace: true }),
    );

    expect(refused.failure.stage).toBe("instance");
    expect(refused.failure.code).toBe("replacement_conflict");
    expect(specs.writes.length).toBe(writesBefore);
    expect(await getInstance(executor, INSTANCE)).toEqual(first.instance);
  });

  it("前の原本の正規化した JSON を読めなければ断る（R2 の応答を信用しない）", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();
    const first = await publishSpec({ specs, registry: executor }, { source: BASE_DECLARATION, instanceId: INSTANCE });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 前の原本の正規化した JSON が読めない（R2 の GET が落ちた形）
    const broken: SpecReader = {
      read: async () => {
        throw new Error("R2 unavailable（値は出さない）");
      },
    };
    const refused = expectRejected(
      await publishSpec({ specs, registry: executor, readSpec: broken }, { source: ADDED_FIELD, instanceId: INSTANCE, replace: true }),
    );

    expect(refused.failure.code).toBe("replacement_conflict");
    expect(await getInstance(executor, INSTANCE)).toEqual(first.instance);
    expect(await resolveInstanceApp(executor, INSTANCE)).toEqual(first.app);
  });

  it("まだ無いインスタンスへ --replace しても、新規として置ける（差し替えではない）", async () => {
    const { executor } = newRegistry();
    const specs = new RecordingSpecWriter();

    const created = await publishSpec(
      { specs, registry: executor, readSpec: specs },
      { source: BASE_DECLARATION, instanceId: INSTANCE, replace: true },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.replacedSourceSha256).toBeNull();
    expect(await countRows(executor, APP_INSTANCES_TABLE)).toBe(1);
  });
});

describe("isReplaceableDeclaration：差し替えてよい宣言か（純粋関数・#175）", () => {
  /** 宣言（YAML）を検査して、正規化した成果物にする */
  const normalized = async (source: string): Promise<{ spec: AppSpec }> => {
    const result = await normalizeSpec(source);
    if (!result.ok) throw new Error("検査に通らない宣言（試験の作りが悪い）");
    return result.app;
  };

  it.each([
    ["項目を足す", ADDED_FIELD, true],
    ["一覧を足す", ADDED_VIEW, true],
    ["項目を消す", REMOVED_FIELD, false],
    ["型を変える", RETYPED_FIELD, false],
    ["entity の名前を変える", RENAMED_ENTITY, false],
  ])("%s：%s", async (_, source, expected) => {
    const before = await normalized(BASE_DECLARATION);
    const after = await normalized(source);
    expect(isReplaceableDeclaration(before, after.spec)).toBe(expected);
  });

  it("前の正規化した JSON の形が読めなければ、差し替えない（false）", async () => {
    const after = await normalized(ADDED_FIELD);
    for (const previous of [undefined, null, "x", 1, {}, { spec: {} }, { spec: { entities: "x" } }, { spec: { entities: [{}] } }]) {
      expect(isReplaceableDeclaration(previous, after.spec), JSON.stringify(previous)).toBe(false);
    }
  });
});
