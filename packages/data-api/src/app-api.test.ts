// アプリケーション関数（Issue #102）の受入試験。
//
// **見本「支出の記録」の採点のシナリオ（19 操作）をそのまま流す**（samples/expense-log/scenario.json）。
// 期待値をここに写さないのは、写すと見本が変わったときにテストだけが古い意味で緑になるためである。
//
// 依存はテストの内側で差し替える（FakeRegistry / FakeSpecStore / FakeRecordStore）。この 3 つは
// src/cloudflare.ts の adapter が包む相手と**同じインターフェース**なので、ここで確かめた判定は
// 実機（D1・R2・DO）でも同じ順で走る。実機の binding と経路は src/index.test.ts が見る。
//
// 時計は差し込む（Q17）。**HTTP からは差し替えられない**（src/index.test.ts が確かめる）。
import { describe, expect, it } from "vitest";
import {
  API_CREATED_STATUS,
  API_READ_STATUS,
  APPSPEC_SCHEMA_VERSION,
  readScoringScenario,
  resolveScenarioIds,
} from "@musunest/appspec-schema";
import type { ApiRow, ApiTransfer, ApiViewBody, NormalizedAppSpec } from "@musunest/appspec-schema";
import { sampleScenarioFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import type { AppRecord } from "@musunest/control-plane";
import type {
  GuardedCreate,
  GuardedDelete,
  GuardedUpdate,
  RecordData,
  RecordStamp,
  ReferenceExpectation,
  ReferenceGuard,
  StoredRecord,
} from "@musunest/app-do";
import type { Clock } from "@musunest/spec-engine";
import { fixedClock, normalizeSpec } from "@musunest/spec-engine";
import type {
  ApiActionBody,
  DataApiDeps,
  InstanceRegistry,
  NormalizedSpecStore,
  RecordStore,
} from "./app-api.js";
import { createFromAction, getSpec, getView, readNormalizedApp } from "./app-api.js";

/**
 * 操作の応答から**行**を取り出す（`create`・`update` の応答）。
 * `delete` の応答は行ではなく `{deleted: true}` なので、そこで呼べば失敗させる。
 */
const rowOf = (body: ApiActionBody): ApiRow => {
  if ("deleted" in body) throw new Error("行ではない応答である（delete の応答）");
  return body;
};

interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFs;

// ── 見本（publish が作る「正規化した JSON」をそのまま使う） ────────────────

const SOURCE = fs.readFileSync(sampleSpecFile("expense-log"), "utf8");
const normalized = await normalizeSpec(SOURCE);
if (!normalized.ok) throw new Error("見本が静的チェックに通らない");

const APP: NormalizedAppSpec = normalized.app;
/** publish が R2 に置く本文（末尾の改行まで含めて、そのまま置く） */
const NORMALIZED_JSON = normalized.json;

const SCENARIO = JSON.parse(fs.readFileSync(sampleScenarioFile("expense-log"), "utf8")) as {
  readonly sample: string;
  readonly clock: string;
  readonly steps: readonly {
    readonly name: string;
    readonly action: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly expect: { readonly accepted?: true; readonly rejected?: { readonly fields: readonly string[]; readonly validations: readonly string[] } };
  }[];
  readonly views: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
};

const STEPS = SCENARIO.steps;
const EXPECTED_ROWS = SCENARIO.views["expenseList"] ?? [];
const CLOCK = fixedClock(SCENARIO.clock);
const INSTANCE = "inst-expense";

const REGISTRATION: AppRecord = {
  sourceSha256: APP.sourceSha256,
  schemaVersion: APP.schemaVersion,
  sourceKey: `specs/${APP.sourceSha256}/app.spec.yaml`,
  normalizedKey: `specs/${APP.sourceSha256}/normalized.json`,
  createdAt: "2026-09-16T00:00:00.000Z",
};

// ── 差し替える依存（adapter が包む相手と同じインターフェース） ─────────────

class FakeRegistry implements InstanceRegistry {
  registration: AppRecord | null = REGISTRATION;
  async resolve(_instanceId: string): Promise<AppRecord | null> {
    return this.registration;
  }
}

class FakeSpecStore implements NormalizedSpecStore {
  text: string | null = NORMALIZED_JSON;
  readonly readKeys: string[] = [];
  async read(key: string): Promise<string | null> {
    this.readKeys.push(key);
    return this.text;
  }
}

/** 1 つの参照の値が、対象の ID を指しているか（`ref` は一致、参照 list は包含。app-do と同じ規則） */
function pointsAt(data: RecordData, guard: ReferenceGuard, id: string): boolean {
  const value = data[guard.field];
  if (guard.list) return Array.isArray(value) && value.includes(id);
  return value === id;
}

/** 書こうとしている行の参照先が実在するか（app-do の records.ts と同じ規則） */
function missingReferences(
  rows: readonly StoredRecord[],
  data: RecordData,
  expectations: readonly ReferenceExpectation[],
): string[] {
  return expectations
    .filter((expectation) => {
      const value = data[expectation.field];
      const ids = expectation.list
        ? Array.isArray(value)
          ? value
          : []
        : typeof value === "string" && value !== ""
          ? [value]
          : [];
      return (
        ids.length === 0 ||
        ids.some(
          (id) => rows.find((row) => row.entity === expectation.to && row.id === id) === undefined,
        )
      );
    })
    .map((expectation) => expectation.field);
}

/** DO の代わり。**保存だけ**を受け持ち、判定は持たない（app-do と同じ分担） */
class FakeRecordStore implements RecordStore {
  readonly rows: StoredRecord[] = [];
  async create(
    entity: string,
    data: RecordData,
    stamp: RecordStamp,
    expectations: readonly ReferenceExpectation[],
  ): Promise<GuardedCreate> {
    // **確かめることと書くことを 1 つの呼出で行う**（実機の DO と同じ約束）
    const fields = missingReferences(this.rows, data, expectations);
    if (fields.length > 0) return { ok: false, reason: "REFERENCE_NOT_FOUND", fields };
    const now = stamp.now ?? "1970-01-01T00:00:00.000Z";
    const record: StoredRecord = {
      entity,
      id: stamp.id ?? `row-${this.rows.length + 1}`,
      data,
      createdAt: now,
      updatedAt: now,
      order: this.rows.length + 1,
    };
    this.rows.push(record);
    return { ok: true, record };
  }
  async list(entity: string): Promise<StoredRecord[]> {
    return this.rows.filter((record) => record.entity === entity);
  }
  async get(entity: string, id: string): Promise<StoredRecord | null> {
    return this.rows.find((record) => record.entity === entity && record.id === id) ?? null;
  }
  /** ID・作成日時・登録順は保ち、更新日時だけを進める（実機の SQL と同じ） */
  async update(
    entity: string,
    id: string,
    data: RecordData,
    stamp: RecordStamp,
    expectations: readonly ReferenceExpectation[],
  ): Promise<GuardedUpdate> {
    const index = this.rows.findIndex((record) => record.entity === entity && record.id === id);
    const before = this.rows[index];
    if (before === undefined) return { ok: false, reason: "NOT_FOUND" };
    const fields = missingReferences(this.rows, data, expectations);
    if (fields.length > 0) return { ok: false, reason: "REFERENCE_NOT_FOUND", fields };
    const after: StoredRecord = { ...before, data, updatedAt: stamp.now ?? before.updatedAt };
    this.rows[index] = after;
    return { ok: true, record: after };
  }
  /**
   * 参照を確かめてから消す（M1.2）。**確認と削除を 1 つの呼出の中で行う**（実機の DO と同じ約束）。
   * 判定の中身は app-do の records.ts が正本で、ここは同じ規則を写したもの——実機での原子性は
   * `@musunest/app-do` の受入試験が本物の workerd で確かめる。
   */
  async deleteGuarded(
    entity: string,
    id: string,
    guards: readonly ReferenceGuard[],
  ): Promise<GuardedDelete> {
    const index = this.rows.findIndex((record) => record.entity === entity && record.id === id);
    if (index < 0) return { ok: false, reason: "NOT_FOUND" };
    const references = guards.flatMap((guard) => {
      const count = this.rows.filter(
        (record) => record.entity === guard.entity && pointsAt(record.data, guard, id),
      ).length;
      return count > 0 ? [{ ...guard, count }] : [];
    });
    if (references.length > 0) return { ok: false, reason: "REFERENCE_IN_USE", references };
    const [record] = this.rows.splice(index, 1);
    if (record === undefined) return { ok: false, reason: "NOT_FOUND" };
    return { ok: true, record };
  }
}

interface Harness {
  readonly deps: DataApiDeps;
  readonly registry: FakeRegistry;
  readonly specs: FakeSpecStore;
  readonly records: FakeRecordStore;
}

function harness(clock: Clock = CLOCK): Harness {
  const registry = new FakeRegistry();
  const specs = new FakeSpecStore();
  const records = new FakeRecordStore();
  return { deps: { registry, specs, records, clock }, registry, specs, records };
}

/** シナリオの 19 操作を先頭から流す */
async function runSteps(h: Harness): Promise<Awaited<ReturnType<typeof createFromAction>>[]> {
  const results: Awaited<ReturnType<typeof createFromAction>>[] = [];
  for (const step of STEPS) {
    results.push(await createFromAction(h.deps, INSTANCE, step.action, step.input));
  }
  return results;
}

const listOf = async (h: Harness): Promise<ApiViewBody> => {
  const result = await getView(h.deps, INSTANCE, "expenseList");
  if (!result.ok) throw new Error(`一覧を読めなかった: ${result.failure.error}`);
  return result.body;
};

/** 項目の順は問わない（意味の文書）。名前の集合として比べる */
const namesOf = (list: readonly string[]): ReadonlySet<string> => new Set(list);

// ── 採点のシナリオ ─────────────────────────────────────────────

describe("expense-log の採点のシナリオ", () => {
  it("19 操作を流す。受理は 4 件、拒否は 15 件", async () => {
    expect(STEPS).toHaveLength(19);
    const h = harness();
    const results = await runSteps(h);

    const accepted = results.filter((result) => result.ok).length;
    expect(accepted).toBe(4);
    expect(results.length - accepted).toBe(15);
    expect(h.records.rows).toHaveLength(4);
  });

  it.each(STEPS.map((step, index) => [step.name, index] as const))(
    "%s の期待どおりに受理・拒否する",
    async (_name, index) => {
      const step = STEPS[index];
      if (step === undefined) throw new Error("手順が無い");
      const h = harness();
      const results = await runSteps(h);
      const result = results[index];
      if (result === undefined) throw new Error("結果が無い");

      if (step.expect.accepted === true) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.status).toBe(API_CREATED_STATUS);
        return;
      }
      const rejected = step.expect.rejected;
      expect(result.ok).toBe(false);
      if (result.ok || rejected === undefined) return;
      expect(result.failure.error).toBe("INPUT_REJECTED");
      // 項目の順は問わない（意味の文書）。宣言の順で返すが、ここでは集合として比べる
      expect(namesOf(result.failure.fields)).toEqual(namesOf(rejected.fields));
      // 検査の名前は**宣言の順**である
      expect(result.failure.validations).toEqual(rejected.validations);
    },
  );

  it("最後の一覧が、採点のシナリオの 4 行と登録順まで一致する", async () => {
    const h = harness();
    await runSteps(h);
    const body = await listOf(h);

    expect(body.instanceId).toBe(INSTANCE);
    expect(body.view).toBe("expenseList");
    expect(body.entity).toBe("expense");
    expect(body.rows).toHaveLength(4);
    expect(body.rows.map((row) => ({ ...row.fields, ...row.computed }))).toEqual(EXPECTED_ROWS);
  });

  it("一覧は、宣言順の列と計算の名前一覧を返す（画面が式を評価しなくてよい）", async () => {
    const h = harness();
    await runSteps(h);
    const body = await listOf(h);

    expect(body.fields).toEqual(["description", "amount", "discount", "payer", "participants"]);
    expect(body.computed).toEqual(["paidAmount", "headcount", "shareAmount"]);
    expect(body.permissions).toEqual({ read: true, write: true });
    expect(body.actions).toEqual([{ name: "addExpense", entity: "expense" }]);
    for (const row of body.rows) {
      expect(Object.keys(row.fields)).toEqual(body.fields);
      expect(Object.keys(row.computed)).toEqual(body.computed);
      expect(typeof row.id).toBe("string");
      expect(row.createdAt).toBe("2026-09-16T03:00:00.000Z");
    }
  });

  it("型で断った入力は検査の式を評価せず、数値の入力は宣言の順に 2 つとも返す", async () => {
    // 受入条件の名指しの 2 例（どちらもシナリオにも入っている）
    const typesFirst = harness();
    const a = await createFromAction(typesFirst.deps, INSTANCE, "addExpense", {
      description: "昼食",
      amount: "0",
      discount: -1,
      payer: "A",
      participants: ["A"],
    });
    expect(a).toEqual({
      ok: false,
      failure: { error: "INPUT_REJECTED", fields: ["amount"], validations: [] },
    });

    const checksFirst = harness();
    const b = await createFromAction(checksFirst.deps, INSTANCE, "addExpense", {
      description: "返品",
      amount: 0,
      discount: -100,
      payer: "A",
      participants: ["A"],
    });
    expect(b).toEqual({
      ok: false,
      failure: {
        error: "INPUT_REJECTED",
        fields: [],
        validations: ["positiveAmount", "nonNegativeDiscount"],
      },
    });
  });

  it("拒否した操作の前後で、DO の件数も内容も変わらない", async () => {
    const h = harness();
    await runSteps(h);
    expect(h.records.rows).toHaveLength(4);
    const before = JSON.stringify(h.records.rows);

    for (const step of STEPS) {
      if (step.expect.rejected === undefined) continue;
      const result = await createFromAction(h.deps, INSTANCE, step.action, step.input);
      expect(result.ok, step.name).toBe(false);
      expect(JSON.stringify(h.records.rows), step.name).toBe(before);
    }
    expect(h.records.rows).toHaveLength(4);
  });

  it("受理した行には、計算の値が保存されていない（入力の項目だけ）", async () => {
    const h = harness();
    await runSteps(h);
    const body = await listOf(h);

    for (const [index, record] of h.records.rows.entries()) {
      expect(Object.keys(record.data)).toEqual([
        "description",
        "amount",
        "discount",
        "payer",
        "participants",
      ]);
      expect(Object.keys(record.data)).not.toContain("paidAmount");
      expect(record.createdAt).toBe("2026-09-16T03:00:00.000Z");
      expect(record.updatedAt).toBe(record.createdAt);
      expect(body.rows[index]?.id).toBe(record.id);
    }
  });

  it("計算の値は保存せず、読むたびに求める（DO の入力データは変わらない）", async () => {
    const h = harness();
    await runSteps(h);
    const before = JSON.stringify(h.records.rows);

    const first = await listOf(h);
    const second = await listOf(h);
    expect(second.rows).toEqual(first.rows);
    expect(h.records.rows).toHaveLength(4);
    expect(JSON.stringify(h.records.rows)).toBe(before);
    // 計算の値は返るが、保存された行は増えも変わらない
    expect(first.rows[0]?.computed).toEqual({ paidAmount: 6000, headcount: 3, shareAmount: 2000 });
  });
});

// ── 時計 ──────────────────────────────────────────────────────

describe("時計（Q17）", () => {
  it("差し込んだ時計が、保存日時の固定値になる", async () => {
    const h = harness(fixedClock("2026-09-16T12:00:00+09:00"));
    const result = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rowOf(result.body).createdAt).toBe("2026-09-16T03:00:00.000Z");
    expect(rowOf(result.body).updatedAt).toBe("2026-09-16T03:00:00.000Z");
    expect(h.records.rows[0]?.createdAt).toBe("2026-09-16T03:00:00.000Z");
  });

  it("別の時刻を差し込めば、別の保存日時になる", async () => {
    const h = harness(fixedClock("2000-01-02T00:00:00Z"));
    const result = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(rowOf(result.body).createdAt).toBe("2000-01-02T00:00:00.000Z");
  });

  it("ID は入力の値では決まらない（店頭が付ける）", async () => {
    const h = harness();
    const withId = { ...STEPS[0]?.input, id: "input-id" };
    const result = await createFromAction(h.deps, INSTANCE, "addExpense", withId);
    // id は宣言の項目ではないので、未知の項目として断る（保存もしない）
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.fields).toEqual(["id"]);
    expect(h.records.rows).toEqual([]);
  });
});

// ── 宣言の取得（spec） ─────────────────────────────────────────

describe("GET spec", () => {
  it("登録から引いた正規化した JSON を、そのまま返す", async () => {
    const h = harness();
    const result = await getSpec(h.deps, INSTANCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(API_READ_STATUS);
    expect(result.body).toEqual({
      instanceId: INSTANCE,
      schemaVersion: APPSPEC_SCHEMA_VERSION,
      sourceSha256: APP.sourceSha256,
      spec: APP.spec,
      permissions: { read: true, write: true },
      actions: [{ name: "addExpense", entity: "expense" }],
    });
    // 登録が指したキーを読む
    expect(h.specs.readKeys).toEqual([REGISTRATION.normalizedKey]);
  });

  it("登録が無いと 404（R2 も読まない）", async () => {
    const h = harness();
    h.registry.registration = null;
    expect(await getSpec(h.deps, "unknown")).toEqual({
      ok: false,
      failure: { error: "NOT_FOUND", fields: [], validations: [] },
    });
    expect(h.specs.readKeys).toEqual([]);
  });
});

// ── 選択肢（enum）と既定値（default）を含む宣言の配信（M1.3。Issue #154） ──
//
// **配信側が読めること**を確かめる。静的チェック（spec-engine）が通っても、data-api の
// `isFieldDeclaration` が新しい型を知らなければ、正規化した JSON は読み取りで落ちて
// `getSpec` / `getView` が **503（SPEC_UNAVAILABLE）** になる。**9 ゲートが緑のまま実経路が
// 動かない**という #145 と同じ穴なので、宣言 → publish → 配信までを通しで見る。
//
// 見本 `samples/task-board/` は #159 が置く。ここでは、その見本と同じ形の最小の宣言を組み立てる。

const ENUM_SOURCE = [
  "entities:",
  "  - name: task",
  "    fields:",
  "      title: string",
  "      status:",
  "        type: enum",
  "        options:",
  "          todo: 未着手",
  "          doing: 進行中",
  "          done: 完了",
  "        default: todo",
  "views:",
  "  - name: taskList",
  "    entity: task",
  "actions:",
  "  - name: addTask",
  "    entity: task",
  "validations: []",
  "computed: []",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
].join("\n");

const enumNormalized = await normalizeSpec(ENUM_SOURCE);
if (!enumNormalized.ok) throw new Error("選択肢の宣言が静的チェックに通らない");

const ENUM_APP: NormalizedAppSpec = enumNormalized.app;
/** publish が R2 に置く本文（`getSpec` に渡すのと同じ形） */
const ENUM_JSON = enumNormalized.json;

/** 選択肢を含む宣言を R2 に置き、登録（D1）も同じ宣言を指すようにする */
function withEnumDeclaration(h: Harness): void {
  h.registry.registration = {
    sourceSha256: ENUM_APP.sourceSha256,
    schemaVersion: ENUM_APP.schemaVersion,
    sourceKey: `specs/${ENUM_APP.sourceSha256}/app.spec.yaml`,
    normalizedKey: `specs/${ENUM_APP.sourceSha256}/normalized.json`,
    createdAt: "2026-09-19T00:00:00.000Z",
  };
  h.specs.text = ENUM_JSON;
}

/** 正規化した JSON の task の項目 status を差し替える（ほかはそのまま） */
function withStatus(h: Harness, status: unknown): void {
  h.specs.text = JSON.stringify({
    ...ENUM_APP,
    spec: { ...ENUM_APP.spec, entities: [{ name: "task", fields: { title: "string", status } }] },
  });
}

describe("選択肢（enum）を含む宣言の配信", () => {
  it("getSpec が ok で返し、options と default を保つ（受入条件）", async () => {
    const h = harness();
    withEnumDeclaration(h);

    const result = await getSpec(h.deps, INSTANCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(API_READ_STATUS);
    expect(result.body.sourceSha256).toBe(ENUM_APP.sourceSha256);
    const task = result.body.spec.entities.find((entity) => entity.name === "task");
    expect(task?.fields["status"]).toEqual({
      type: "enum",
      options: { todo: "未着手", doing: "進行中", done: "完了" },
      default: "todo",
    });
  });

  it("getView も ok で返し、選択肢の項目を列に持つ", async () => {
    const h = harness();
    withEnumDeclaration(h);

    const result = await getView(h.deps, INSTANCE, "taskList");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.fields).toEqual(["title", "status"]);
  });

  it("readNormalizedApp が、選択肢を含む正規化 JSON を読む（受入条件）", () => {
    expect(readNormalizedApp(ENUM_JSON)).toEqual(ENUM_APP);
  });

  it.each([
    ["options が空", { type: "enum", options: {} }],
    ["default が options のキーに無い", { type: "enum", options: { todo: "未着手" }, default: "doing" }],
    ["表示名が文字列でない", { type: "enum", options: { todo: 1 } }],
    ["表示名が空である", { type: "enum", options: { todo: "" } }],
    ["default が文字列でない", { type: "enum", options: { todo: "未着手" }, default: 1 }],
    ["enum が写像でない", "enum"],
  ] as readonly (readonly [string, unknown])[])(
    "%s は読めない（SPEC_UNAVAILABLE。成功に読み替えない）",
    async (_label, status) => {
      const h = harness();
      withEnumDeclaration(h);
      withStatus(h, status);

      expect(await getSpec(h.deps, INSTANCE)).toEqual({
        ok: false,
        failure: { error: "SPEC_UNAVAILABLE", fields: [], validations: [] },
      });
    },
  );
});

// ── 日付（date）を含む宣言の配信と保存（M1.3。Issue #155） ──────────
//
// **配信側が読めること**と、**`YYYY-MM-DD` でない値を data-api が断ること**を確かめる。
// 静的チェック（spec-engine）が通っても、`isFieldDeclaration` が新しい型を知らなければ
// 正規化した JSON は読み取りで落ちて `getSpec` が **503（SPEC_UNAVAILABLE）** になる
// （#145・#154 と同じ穴）。保存の判定は data-api（唯一の権限強制点）にある。
//
// 見本 `samples/task-board/` は #159 が置く。ここでは、その見本と同じ形の最小の宣言を組み立てる。

const DATE_SOURCE = [
  "entities:",
  "  - name: task",
  "    fields:",
  "      title: string",
  "      due: date",
  "views:",
  "  - name: taskList",
  "    entity: task",
  "actions:",
  "  - name: addTask",
  "    entity: task",
  "validations:",
  "  - name: dueBeforeToday",
  "    entity: task",
  "    expression: due < today()",
  "computed: []",
  "permissions:",
  "  - name: read",
  "    subject: minIdentity",
  "  - name: write",
  "    subject: minIdentity",
  "minIdentity:",
  "  mode: anonymous",
].join("\n");

const dateNormalized = await normalizeSpec(DATE_SOURCE);
if (!dateNormalized.ok) throw new Error("日付の宣言が静的チェックに通らない");

const DATE_APP: NormalizedAppSpec = dateNormalized.app;
/** publish が R2 に置く本文（`getSpec` に渡すのと同じ形） */
const DATE_JSON = dateNormalized.json;

/** 日付を含む宣言を R2 に置き、登録（D1）も同じ宣言を指すようにする */
function withDateDeclaration(h: Harness): void {
  h.registry.registration = {
    sourceSha256: DATE_APP.sourceSha256,
    schemaVersion: DATE_APP.schemaVersion,
    sourceKey: `specs/${DATE_APP.sourceSha256}/app.spec.yaml`,
    normalizedKey: `specs/${DATE_APP.sourceSha256}/normalized.json`,
    createdAt: "2026-09-19T00:00:00.000Z",
  };
  h.specs.text = DATE_JSON;
}

describe("日付（date）を含む宣言の配信と保存", () => {
  it("getSpec が ok で返し、date の項目を保つ（受入条件）", async () => {
    const h = harness();
    withDateDeclaration(h);

    const result = await getSpec(h.deps, INSTANCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(API_READ_STATUS);
    expect(result.body.sourceSha256).toBe(DATE_APP.sourceSha256);
    const task = result.body.spec.entities.find((entity) => entity.name === "task");
    expect(task?.fields["due"]).toBe("date");
  });

  it("readNormalizedApp が、日付を含む正規化 JSON を読む（受入条件）", () => {
    expect(readNormalizedApp(DATE_JSON)).toEqual(DATE_APP);
  });

  it("YYYY-MM-DD の値は保存され、書いた行が返る", async () => {
    const h = harness();
    withDateDeclaration(h);

    const result = await createFromAction(h.deps, INSTANCE, "addTask", {
      title: "宿の予約",
      due: "2026-09-15",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(API_CREATED_STATUS);
    expect(rowOf(result.body).fields).toEqual({ title: "宿の予約", due: "2026-09-15" });
    expect(h.records.rows).toHaveLength(1);
  });

  it.each([
    ["スラッシュ区切り", "2026/09/15"],
    ["0 を詰めていない", "2026-9-5"],
    ["時刻が付いている", "2026-09-15T00:00:00Z"],
    ["空文字（未入力のまま送った）", ""],
    ["数", 20260915],
    ["null", null],
    ["並び", ["2026-09-15"]],
  ] as const)("YYYY-MM-DD でない値（%s）は保存されない（受入条件）", async (_label, due) => {
    const h = harness();
    withDateDeclaration(h);

    const result = await createFromAction(h.deps, INSTANCE, "addTask", { title: "宿の予約", due });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.error).toBe("INPUT_REJECTED");
    // 通らなかった項目の名前を返し、**保存しない**
    expect(result.failure.fields).toEqual(["due"]);
    expect(h.records.rows).toEqual([]);
  });

  it("差し込んだ時計（due < today()）が保存の可否を決める（受入条件）", async () => {
    const h = harness();
    withDateDeclaration(h);
    // 差し込んだ時計（採点のシナリオ）は日本時間の 2026-09-16 である
    const today = await createFromAction(h.deps, INSTANCE, "addTask", { title: "今日", due: "2026-09-16" });
    expect(today.ok).toBe(false);
    if (!today.ok) expect(today.failure.validations).toEqual(["dueBeforeToday"]);
    expect(h.records.rows).toEqual([]);

    const yesterday = await createFromAction(h.deps, INSTANCE, "addTask", {
      title: "昨日",
      due: "2026-09-15",
    });
    expect(yesterday.ok).toBe(true);
    expect(h.records.rows).toHaveLength(1);
  });

  it("getView も ok で返し、date の項目を列に持つ", async () => {
    const h = harness();
    withDateDeclaration(h);

    const result = await getView(h.deps, INSTANCE, "taskList");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.fields).toEqual(["title", "due"]);
  });
});

// ── 権限（唯一の権限強制点） ────────────────────────────────────

/** `permissions` を差し替えた宣言を R2 に置く（版と SHA は登録と一致させたまま） */
function withPermissions(h: Harness, names: readonly ("read" | "write")[]): void {
  h.specs.text = JSON.stringify({
    ...APP,
    spec: {
      ...APP.spec,
      permissions: APP.spec.permissions.filter((permission) => names.includes(permission.name)),
    },
  });
}

describe("権限（read / write を個別に外した宣言）", () => {
  it("read が無ければ、spec は 403", async () => {
    const h = harness();
    withPermissions(h, ["write"]);
    expect(await getSpec(h.deps, INSTANCE)).toEqual({
      ok: false,
      failure: { error: "PERMISSION_DENIED", fields: [], validations: [] },
    });
  });

  it("read が無ければ、一覧は 403（DO も読まない）", async () => {
    const h = harness();
    withPermissions(h, ["write"]);
    const result = await getView(h.deps, INSTANCE, "expenseList");
    expect(result).toEqual({
      ok: false,
      failure: { error: "PERMISSION_DENIED", fields: [], validations: [] },
    });
  });

  it("write が無ければ、追加は 403 で、保存もしない", async () => {
    const h = harness();
    withPermissions(h, ["read"]);
    const result = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(result).toEqual({
      ok: false,
      failure: { error: "PERMISSION_DENIED", fields: [], validations: [] },
    });
    expect(h.records.rows).toEqual([]);
  });

  it("write が無くても、read があれば一覧は読める", async () => {
    const h = harness();
    withPermissions(h, ["read"]);
    const result = await getView(h.deps, INSTANCE, "expenseList");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.permissions).toEqual({ read: true, write: false });
      expect(result.body.rows).toEqual([]);
    }
  });

  it("権限が 1 つも無ければ、3 経路とも断る", async () => {
    const h = harness();
    withPermissions(h, []);
    expect((await getSpec(h.deps, INSTANCE)).ok).toBe(false);
    expect((await getView(h.deps, INSTANCE, "expenseList")).ok).toBe(false);
    const created = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(created.ok).toBe(false);
    expect(h.records.rows).toEqual([]);
  });

  it("宣言した操作だけを実行する（宣言に無い action は 404）", async () => {
    const h = harness();
    const result = await createFromAction(h.deps, INSTANCE, "deleteExpense", {});
    expect(result).toEqual({
      ok: false,
      failure: { error: "NOT_FOUND", fields: [], validations: [] },
    });
    expect(h.records.rows).toEqual([]);
  });

  it("宣言に無い view は 404", async () => {
    const h = harness();
    expect(await getView(h.deps, INSTANCE, "memberList")).toEqual({
      ok: false,
      failure: { error: "NOT_FOUND", fields: [], validations: [] },
    });
  });

  it("別の entity への汎用の書込口が無い（action は宣言の名前だけ）", async () => {
    const h = harness();
    // entity の名前を action の名前として渡しても、宣言に無いので通らない
    expect((await createFromAction(h.deps, INSTANCE, "expense", STEPS[0]?.input ?? {})).ok).toBe(false);
    expect(h.records.rows).toEqual([]);
  });
});

// ── 宣言の整合性（読み書きを進めない） ────────────────────────────

describe("登録と R2 と宣言の整合性", () => {
  it("R2 にオブジェクトが無ければ 503（成功応答も書込も無い）", async () => {
    const h = harness();
    h.specs.text = null;
    expect((await getSpec(h.deps, INSTANCE)).ok).toBe(false);
    const created = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(created).toEqual({
      ok: false,
      failure: { error: "SPEC_UNAVAILABLE", fields: [], validations: [] },
    });
    expect(h.records.rows).toEqual([]);
  });

  it("壊れた JSON は 503（成功応答も書込も無い）", async () => {
    const h = harness();
    h.specs.text = `{"schemaVersion": "${APPSPEC_SCHEMA_VERSION}", "sourceSha256": "${APP.sourceSha256}", "spec": {`;
    const created = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.failure.error).toBe("SPEC_UNAVAILABLE");
    expect(h.records.rows).toEqual([]);
  });

  it("欄が欠けていれば 503（成功応答も書込も無い）", async () => {
    const h = harness();
    const { spec, ...rest } = APP;
    expect(spec).toBeDefined();
    h.specs.text = JSON.stringify(rest);
    const created = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.failure.error).toBe("SPEC_UNAVAILABLE");
    expect(h.records.rows).toEqual([]);
  });

  it("原本の SHA が登録と食い違えば 503", async () => {
    const h = harness();
    h.specs.text = JSON.stringify({ ...APP, sourceSha256: "b".repeat(64) });
    expect((await getSpec(h.deps, INSTANCE)).ok).toBe(false);
    const created = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.failure.error).toBe("SPEC_UNAVAILABLE");
    expect(h.records.rows).toEqual([]);
  });

  it("版が登録と食い違えば 503", async () => {
    const h = harness();
    h.specs.text = JSON.stringify({ ...APP, schemaVersion: "community.app-spec/v9.9-draft" });
    const created = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.failure.error).toBe("SPEC_UNAVAILABLE");
    expect(h.records.rows).toEqual([]);
  });

  it("知らない形の版は 503", async () => {
    const h = harness();
    h.registry.registration = { ...REGISTRATION, schemaVersion: "v0.2" };
    h.specs.text = JSON.stringify({ ...APP, schemaVersion: "v0.2" });
    const result = await getSpec(h.deps, INSTANCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.error).toBe("SPEC_UNAVAILABLE");
  });

  it("登録が指していないキーを読まない（登録の normalizedKey だけを読む）", async () => {
    const h = harness();
    h.registry.registration = { ...REGISTRATION, normalizedKey: "specs/other/normalized.json" };
    await getSpec(h.deps, INSTANCE);
    expect(h.specs.readKeys).toEqual(["specs/other/normalized.json"]);
  });
});

describe("readNormalizedApp（正規化した JSON の読み取り）", () => {
  it("publish が作った本文を読める", () => {
    expect(readNormalizedApp(NORMALIZED_JSON)).toEqual(APP);
  });

  it.each([
    ["JSON として読めない", "{"],
    ["オブジェクトでない", "[]"],
    ["null", "null"],
    ["版が無い", `{"sourceSha256": "${APP.sourceSha256}", "spec": {}}`],
    ["版の形が違う", `{"schemaVersion": "0.2", "sourceSha256": "${APP.sourceSha256}", "spec": {}}`],
    ["SHA が 64 桁でない", `{"schemaVersion": "${APPSPEC_SCHEMA_VERSION}", "sourceSha256": "abc", "spec": {}}`],
    ["spec が無い", `{"schemaVersion": "${APPSPEC_SCHEMA_VERSION}", "sourceSha256": "${APP.sourceSha256}"}`],
    [
      "spec の欄が欠けている",
      `{"schemaVersion": "${APPSPEC_SCHEMA_VERSION}", "sourceSha256": "${APP.sourceSha256}", "spec": {"entities": []}}`,
    ],
    [
      "entity の fields が無い",
      `{"schemaVersion": "${APPSPEC_SCHEMA_VERSION}", "sourceSha256": "${APP.sourceSha256}", "spec": {"entities": [{"name": "expense"}], "views": [], "actions": [], "validations": [], "computed": [], "permissions": [], "minIdentity": {"mode": "anonymous"}}}`,
    ],
  ])("%s ものは null（成功値に読み替えない）", (_label, text) => {
    expect(readNormalizedApp(text)).toBeNull();
  });
});

// ── warikan の採点のシナリオ（参照と文言。Issue #106） ────────────────────
//
// 見本 warikan のシナリオをそのまま流す。**動的に割り当てた ID は、シナリオの `bind` と `$名前` で
// 対応づける**（readScoringScenario が読み、resolveScenarioIds が実際の ID に置き換える）。
// 確かめるのは 3 つである。
//   1. A・B・C を登録して得た ID を使う 2 支出が保存され、payer と participants は ID のまま往復する
//   2. 存在しない ID・別 entity の ID は 422 INPUT_REJECTED になり、対象の項目名を返し、保存件数が変わらない
//   3. 文言を持つ検査は名前と文言を返し、文言を持たない検査（expense-log）は名前だけを返す

const WARIKAN_INSTANCE = "inst-warikan";
const WARIKAN = await normalizeSpec(fs.readFileSync(sampleSpecFile("warikan"), "utf8"));
if (!WARIKAN.ok) throw new Error("warikan が静的チェックに通らない");
const WARIKAN_JSON = WARIKAN.json;
const WARIKAN_APP = WARIKAN.app;

const WARIKAN_REGISTRATION: AppRecord = {
  sourceSha256: WARIKAN_APP.sourceSha256,
  schemaVersion: WARIKAN_APP.schemaVersion,
  sourceKey: `specs/${WARIKAN_APP.sourceSha256}/app.spec.yaml`,
  normalizedKey: `specs/${WARIKAN_APP.sourceSha256}/normalized.json`,
  createdAt: "2026-09-16T00:00:00.000Z",
};

const WARIKAN_SCENARIO = readScoringScenario(
  JSON.parse(fs.readFileSync(sampleScenarioFile("warikan"), "utf8")),
);

interface WarikanRun {
  readonly deps: DataApiDeps;
  readonly records: FakeRecordStore;
  readonly ids: Readonly<Record<string, string>>;
  readonly results: readonly Awaited<ReturnType<typeof createFromAction>>[];
}

/** シナリオの手順を先頭から流し、`bind` の名前を実際に登録して得た ID に結びつける */
async function runWarikan(clock: Clock = CLOCK): Promise<WarikanRun> {
  const records = new FakeRecordStore();
  const deps: DataApiDeps = {
    registry: { resolve: async () => WARIKAN_REGISTRATION },
    specs: { read: async () => WARIKAN_JSON },
    records,
    clock,
  };
  const ids: Record<string, string> = {};
  const results: Awaited<ReturnType<typeof createFromAction>>[] = [];
  for (const step of WARIKAN_SCENARIO.steps) {
    const input = resolveScenarioIds(step.input, ids) as Readonly<Record<string, unknown>>;
    const result = await createFromAction(deps, WARIKAN_INSTANCE, step.action, input);
    results.push(result);
    if (result.ok && "accepted" in step.expect && step.expect.bind !== undefined) {
      ids[step.expect.bind] = result.body.id;
    }
  }
  return { deps, records, ids, results };
}

const warikanExpenses = (run: WarikanRun) => run.records.rows.filter((row) => row.entity === "expense");

describe("warikan の採点のシナリオ（参照と文言。M1.2）", () => {
  it("A・B・C を登録し、2 支出が受理される（拒否した入力は保存しない）", async () => {
    const run = await runWarikan();
    const accepted = run.results.filter((result) => result.ok).length;
    expect(accepted).toBe(5); // メンバー 3 人 + 支出 2 件
    // 拒否は 7 件（金額 0・**金額が小数**・割る人が空・重複・存在しない ID・別 entity の ID・参照 list の不明な ID）
    expect(run.results.length - accepted).toBe(7);
    expect(run.records.rows.filter((row) => row.entity === "member")).toHaveLength(3);
    expect(warikanExpenses(run)).toHaveLength(2);
  });

  it("payer と participants は ID のまま往復する", async () => {
    const run = await runWarikan();
    const expenses = warikanExpenses(run);
    expect(expenses[0]?.data).toEqual({
      description: "夕食",
      amount: 6000,
      payer: run.ids["A"],
      participants: [run.ids["A"], run.ids["B"], run.ids["C"]],
    });
    expect(expenses[1]?.data["payer"]).toBe(run.ids["B"]);
    // 名前を保存していない（ID と名前は別の値である）
    expect(JSON.stringify(run.records.rows)).not.toContain('"payer":"A"');
  });

  it("最後の一覧が、シナリオの期待値と一致する（ID を名前ではなく ID のまま比べる）", async () => {
    const run = await runWarikan();
    const expected = (WARIKAN_SCENARIO.views["expenseList"] ?? []).map((row) =>
      resolveScenarioIds(row, run.ids),
    );
    const body = await getView(run.deps, WARIKAN_INSTANCE, "expenseList");
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.body.rows.map((row) => ({ ...row.fields, ...row.computed }))).toEqual(expected);

    const members = await getView(run.deps, WARIKAN_INSTANCE, "memberList");
    if (!members.ok) throw new Error("memberList を読めなかった");
    const expectedMembers = (WARIKAN_SCENARIO.views["memberList"] ?? []).map((row) =>
      resolveScenarioIds(row, run.ids),
    );
    // 項目と計算値（集計）を合わせて比べる（memberList は name と paid/owed/balance を持つ。M1.2）
    expect(members.body.rows.map((row) => ({ ...row.fields, ...row.computed }))).toEqual(expectedMembers);
  });

  it.each(WARIKAN_SCENARIO.steps.map((step, index) => [step.name, index] as const))(
    "%s の期待どおりに受理・拒否する",
    async (_name, index) => {
      const step = WARIKAN_SCENARIO.steps[index];
      if (step === undefined) throw new Error("手順が無い");
      const run = await runWarikan();
      const result = run.results[index];
      if (result === undefined) throw new Error("結果が無い");
      if ("accepted" in step.expect) {
        expect(result.ok).toBe(true);
        return;
      }
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.error).toBe("INPUT_REJECTED");
      expect(namesOf(result.failure.fields)).toEqual(namesOf(step.expect.rejected.fields));
      expect(result.failure.validations).toEqual(step.expect.rejected.validations);
    },
  );

  it("拒否した操作の前後で、保存件数が変わらない", async () => {
    const run = await runWarikan();
    const before = JSON.stringify(run.records.rows);
    for (const step of WARIKAN_SCENARIO.steps) {
      if ("accepted" in step.expect) continue;
      const input = resolveScenarioIds(step.input, run.ids) as Readonly<Record<string, unknown>>;
      const result = await createFromAction(run.deps, WARIKAN_INSTANCE, step.action, input);
      expect(result.ok, step.name).toBe(false);
      expect(JSON.stringify(run.records.rows), step.name).toBe(before);
    }
    expect(warikanExpenses(run)).toHaveLength(2);
  });

  it("存在しない ID・別 entity の ID は、対象の項目名を返して断る", async () => {
    const run = await runWarikan();
    const member = run.ids["A"] ?? "";

    const missing = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "昼食",
      amount: 3000,
      payer: "member-does-not-exist",
      participants: [member],
    });
    expect(missing).toEqual({
      ok: false,
      failure: { error: "INPUT_REJECTED", fields: ["payer"], validations: [] },
    });

    // 夕食の ID（expense のレコード）を member の参照に渡す＝別 entity の ID
    const otherEntity = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "昼食",
      amount: 3000,
      payer: warikanExpenses(run)[0]?.id ?? "",
      participants: [member],
    });
    expect(otherEntity.ok).toBe(false);
    if (!otherEntity.ok) expect(otherEntity.failure.fields).toEqual(["payer"]);

    expect(warikanExpenses(run)).toHaveLength(2);
  });

  it("別インスタンスの ID も、この DO に無いので断る", async () => {
    // 同じ宣言を使う別のインスタンスの ID は、このインスタンスの一覧には無い
    const other = await runWarikan();
    const run = await runWarikan();
    const result = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "昼食",
      amount: 3000,
      payer: other.ids["A"] ?? "",
      participants: [run.ids["A"] ?? ""],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.fields).toEqual(["payer"]);
  });

  it("文言を持つ検査は、名前と文言を同じ並びで返す", async () => {
    const run = await runWarikan();
    const result = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "返品",
      amount: 0,
      payer: run.ids["A"] ?? "",
      participants: [run.ids["A"] ?? ""],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.validations).toEqual(["positiveAmount"]);
    expect(result.failure.validationMessages).toEqual(["金額は 1 円以上にしてください"]);
  });

  it("文言を持たない expense-log は、従来どおり検査の名前だけを返す", async () => {
    const h = harness();
    const result = await createFromAction(h.deps, INSTANCE, "addExpense", {
      description: "返品",
      amount: 0,
      discount: 0,
      payer: "A",
      participants: ["A"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.validations).toEqual(["positiveAmount"]);
    // 欄そのものを持たない（#102 の応答を変えない）
    expect(Object.hasOwn(result.failure, "validationMessages")).toBe(false);
  });
});

// ── warikan の集計（entity をまたぐ sum・count。Issue #107） ──────────────
//
// 評価の単位（spec-engine の aggregate.test.ts）と**同じ数字**を、API（getView）の値でも確かめる。
// 集計は同じインスタンスの DO のレコードだけを見る（別インスタンスの支出は混ざらない）。

/** メンバーの一覧を読んで、名前 → 計算値 の対応を返す */
async function memberComputed(
  run: WarikanRun,
): Promise<ReadonlyMap<unknown, Readonly<Record<string, number | null>>>> {
  const members = await getView(run.deps, WARIKAN_INSTANCE, "memberList");
  if (!members.ok) throw new Error("memberList を読めなかった");
  return new Map(members.body.rows.map((row) => [row.fields["name"], row.computed]));
}

describe("warikan の集計（entity をまたぐ sum・count。M1.2）", () => {
  it("member 一覧の paid/owed/balance が、受入条件の値になる", async () => {
    const run = await runWarikan();
    const members = await getView(run.deps, WARIKAN_INSTANCE, "memberList");
    if (!members.ok) throw new Error("memberList を読めなかった");
    expect(members.body.computed).toEqual(["paid", "owed", "balance"]);

    const byName = await memberComputed(run);
    expect(byName.get("A")).toEqual({ paid: 6000, owed: 3000, balance: 3000 });
    expect(byName.get("B")).toEqual({ paid: 3000, owed: 3000, balance: 0 });
    expect(byName.get("C")).toEqual({ paid: 0, owed: 3000, balance: -3000 });
  });

  it("expense 一覧の shareAmount は、夕食 2000・タクシー 1000 である", async () => {
    const run = await runWarikan();
    const list = await getView(run.deps, WARIKAN_INSTANCE, "expenseList");
    if (!list.ok) throw new Error("expenseList を読めなかった");
    expect(list.body.rows.map((row) => row.computed["shareAmount"])).toEqual([2000, 1000]);
  });

  it("支出が 1 件も無いメンバーの計算値は 0 である（null ではない）", async () => {
    const run = await runWarikan();
    const added = await createFromAction(run.deps, WARIKAN_INSTANCE, "addMember", { name: "D" });
    expect(added.ok).toBe(true);
    if (added.ok) expect(rowOf(added.body).computed).toEqual({ paid: 0, owed: 0, balance: 0 });

    const byName = await memberComputed(run);
    expect(byName.get("D")).toEqual({ paid: 0, owed: 0, balance: 0 });
  });

  it("集計元に null が 1 つでもあれば、その集計値も null になる（空集合の 0 と区別する）", async () => {
    const run = await runWarikan();
    // 有限でない amount は入力の型検査が断るので、**保存された行**として直接置く
    // （評価は「型検査を通った行」だけを受け取る建前だが、壊れた成果物でも 0 に読み替えないことを見る）
    run.records.rows.push({
      entity: "expense",
      id: "broken",
      data: {
        description: "壊れた",
        amount: Number.POSITIVE_INFINITY,
        payer: run.ids["A"] ?? "",
        participants: [run.ids["A"] ?? ""],
      },
      createdAt: "2026-09-16T03:00:00.000Z",
      updatedAt: "2026-09-16T03:00:00.000Z",
      order: run.records.rows.length + 1,
    });

    const byName = await memberComputed(run);
    // 支出ごとの shareAmount が null になり、それを足す owed も null。paid（amount を足す）も同じ
    expect(byName.get("A")).toEqual({ paid: null, owed: null, balance: null });
    // 壊れた行の影響を受けないメンバーは、0 のままである（空集合の 0 と null を混ぜない）
    expect(byName.get("B")).toEqual({ paid: 3000, owed: 3000, balance: 0 });
  });

  it("集計値と計算値は保存されない（保存された行は入力の項目だけである）", async () => {
    const run = await runWarikan();
    for (const record of run.records.rows) {
      const keys = Object.keys(record.data);
      for (const name of ["paid", "owed", "balance", "headcount", "shareAmount"]) {
        expect(keys, `${record.entity}: ${name}`).not.toContain(name);
      }
    }
  });
});

// ── warikan の精算（`settle`。Issue #108） ────────────────────────────
//
// 精算の値は **API が返す**（`GET .../views/memberList` の `settlement`）。画面は計算し直さない
// （表示は別の Issue）。ここでは 4 つを確かめる。
//   1. 見本 warikan の精算が、受入条件の 1 件（C → A 3000）になる
//   2. 割り切れない額でも、端数（Q13）が API の値に出る
//   3. 精算を宣言していない entity・宣言そのものが無い見本では、欄を載せない（M1.1 の応答を変えない）
//   4. 金額が小数の支出は、入力の検査で断る（Q18-6。保存もしない）

/** メンバーの一覧の精算。**宣言していないときは `undefined`** である */
async function settlementOf(run: WarikanRun): Promise<readonly ApiTransfer[] | null | undefined> {
  const members = await getView(run.deps, WARIKAN_INSTANCE, "memberList");
  if (!members.ok) throw new Error("memberList を読めなかった");
  return members.body.settlement;
}

/**
 * warikan の宣言で、メンバーだけを登録順に作ったインスタンス（受入条件の数字を、見本の 2 支出に
 * 混ぜずに確かめる）。返す `ids` は**登録順**である。
 */
async function warikanWithMembers(
  names: readonly string[],
): Promise<{ readonly deps: DataApiDeps; readonly records: FakeRecordStore; readonly ids: readonly string[] }> {
  const records = new FakeRecordStore();
  const deps: DataApiDeps = {
    registry: { resolve: async () => WARIKAN_REGISTRATION },
    specs: { read: async () => WARIKAN_JSON },
    records,
    clock: CLOCK,
  };
  const ids: string[] = [];
  for (const name of names) {
    const created = await createFromAction(deps, WARIKAN_INSTANCE, "addMember", { name });
    if (!created.ok) throw new Error(`メンバー ${name} を登録できなかった`);
    ids.push(created.body.id);
  }
  return { deps, records, ids };
}

const viewOf = async (
  deps: DataApiDeps,
): Promise<ApiViewBody> => {
  const members = await getView(deps, WARIKAN_INSTANCE, "memberList");
  if (!members.ok) throw new Error("memberList を読めなかった");
  return members.body;
};

describe("warikan の精算（settle。M1.2）", () => {
  it("memberList が、店頭が組んだ送金の並びを返す（C → A 3000 の 1 件だけ）", async () => {
    const run = await runWarikan();
    const members = await getView(run.deps, WARIKAN_INSTANCE, "memberList");
    if (!members.ok) throw new Error("memberList を読めなかった");
    expect(members.body.settlement).toEqual([
      { from: run.ids["C"] ?? "", to: run.ids["A"] ?? "", amount: 3000 },
    ]);
    // **精算は行ごとの値ではない**ので、計算の列には出さない
    expect(members.body.computed).toEqual(["paid", "owed", "balance"]);
    for (const row of members.body.rows) expect(Object.keys(row.computed)).toEqual(members.body.computed);
  });

  it("1000 円を A が払い A/B/C で割ると、精算は B→A 333・C→A 333 の順になる（端数は settle の中で解く）", async () => {
    const run = await warikanWithMembers(["A", "B", "C"]);
    const [a = "", b = "", c = ""] = run.ids;
    const added = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "昼食",
      amount: 1000,
      payer: a,
      participants: [a, b, c],
    });
    expect(added.ok).toBe(true);
    const body = await viewOf(run.deps);

    // **余りの配賦は宣言に足さない**（Q18-5）。`owed` は基準額（`amount / 人数`）の集計のままである
    expect(body.rows.map((row) => row.computed["paid"])).toEqual([1000, 0, 0]);
    expect(body.rows.map((row) => row.computed["owed"])).toEqual([1000 / 3, 1000 / 3, 1000 / 3]);
    // 端数（A が 1 円多く負担する）は、精算の値にだけ現れる
    expect(body.settlement).toEqual([
      { from: b, to: a, amount: 333 },
      { from: c, to: a, amount: 333 },
    ]);
  });

  it("登録順 A/B/C/D で D が払い参加者を C/B/A にしても、精算は A→D 334・B→D 333・C→D 333 の順になる", async () => {
    const run = await warikanWithMembers(["A", "B", "C", "D"]);
    const [a = "", b = "", c = "", d = ""] = run.ids;
    const added = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "昼食",
      amount: 1000,
      payer: d,
      participants: [c, b, a],
    });
    expect(added.ok).toBe(true);
    // 余りは払った人 D ではなく、**登録が最も早い参加者 A** が持つ（入力の並び順では決めない）
    expect((await viewOf(run.deps)).settlement).toEqual([
      { from: a, to: d, amount: 334 },
      { from: b, to: d, amount: 333 },
      { from: c, to: d, amount: 333 },
    ]);
  });

  it("払った人と負担した人が同じ支出（差し引き 0）は、送金に現れない", async () => {
    const run = await runWarikan();
    const added = await createFromAction(run.deps, WARIKAN_INSTANCE, "addMember", { name: "D" });
    expect(added.ok).toBe(true);
    const id = added.ok ? added.body.id : "";
    const only = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "自分の分",
      amount: 1000,
      payer: id,
      participants: [id],
    });
    expect(only.ok).toBe(true);
    // D は払って負担したので差し引き 0。ほかの 3 人の送金は変わらない
    expect(await settlementOf(run)).toEqual([
      { from: run.ids["C"] ?? "", to: run.ids["A"] ?? "", amount: 3000 },
    ]);
  });

  it("精算を宣言していない一覧には、欄そのものを載せない", async () => {
    const run = await runWarikan();
    const expenses = await getView(run.deps, WARIKAN_INSTANCE, "expenseList");
    if (!expenses.ok) throw new Error("expenseList を読めなかった");
    expect(Object.hasOwn(expenses.body, "settlement")).toBe(false);
  });

  it("M1.1 の見本（settle を宣言していない）の一覧にも、欄そのものを載せない", async () => {
    const h = harness();
    await runSteps(h);
    const body = await listOf(h);
    expect(Object.hasOwn(body, "settlement")).toBe(false);
  });

  it("金額が小数の支出は、入力の検査で断る（Q18-6。保存もしない）", async () => {
    const run = await runWarikan();
    const before = JSON.stringify(run.records.rows);
    const result = await createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
      description: "端数",
      amount: 333.5,
      payer: run.ids["A"] ?? "",
      participants: [run.ids["A"] ?? "", run.ids["B"] ?? ""],
    });
    expect(result).toEqual({
      ok: false,
      failure: { error: "INPUT_REJECTED", fields: ["amount"], validations: [] },
    });
    expect(JSON.stringify(run.records.rows)).toBe(before);
    expect(warikanExpenses(run)).toHaveLength(2);
  });

  it("支出の行が読めなければ、精算は null になる（空の並びに読み替えない）", async () => {
    const run = await runWarikan();
    // 有限でない額は入力の検査が断るので、**保存された行**として直接置く（壊れた成果物でも緑にしない）
    run.records.rows.push({
      entity: "expense",
      id: "broken",
      data: {
        description: "壊れた",
        amount: Number.POSITIVE_INFINITY,
        payer: run.ids["A"] ?? "",
        participants: [run.ids["A"] ?? ""],
      },
      createdAt: "2026-09-16T03:00:00.000Z",
      updatedAt: "2026-09-16T03:00:00.000Z",
      order: run.records.rows.length + 1,
    });
    // 集計（`computed`）と同じ約束である——読めなかった値は `null`。空の並び（送金が要らない）とは区別する
    expect(await settlementOf(run)).toBeNull();
  });
});

// ── 直す・消す（M1.2。Issue #109） ──────────────────────────────────────
//
// 受入条件の数字をそのまま確かめる。**夕食を 6000→3000 に直し**、続けて**タクシーを消す**。
// 参照されているメンバーは消せない（409 `REFERENCE_IN_USE`）——**画面ではなく API への直接送信**で
// 断られることを見る（画面の非表示は守りではない。03 §2.2）。

/** 精算の並びを、見本の期待値と同じ「C→A 1000」の形にする（画面が見せる形である） */
async function settlementLines(run: WarikanRun): Promise<string[]> {
  const view = await getView(run.deps, WARIKAN_INSTANCE, "settlement");
  if (!view.ok) throw new Error("settlement を読めなかった");
  const transfers = view.body.settlement ?? [];
  const names = new Map(
    run.records.rows
      .filter((row) => row.entity === "member")
      .map((row) => [row.id, String(row.data["name"])]),
  );
  return transfers.map(
    (transfer) => `${names.get(transfer.from) ?? transfer.from}→${names.get(transfer.to) ?? transfer.to} ${transfer.amount}`,
  );
}

describe("夕食を直し、タクシーを消す（M1.2。受入条件の数字）", () => {
  it("夕食を 6000→3000 に直すと、A=3000/2000/1000・B=3000/2000/1000・C=0/2000/-2000、精算は C→A 1000・C→B 1000", async () => {
    const run = await runWarikan();
    const updated = await createFromAction(run.deps, WARIKAN_INSTANCE, "editExpense", {
      id: run.ids["dinner"] ?? "",
      description: "夕食",
      amount: 3000,
      payer: run.ids["A"] ?? "",
      participants: [run.ids["A"] ?? "", run.ids["B"] ?? "", run.ids["C"] ?? ""],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // 直した行が返る（計算値も、直した値から求める）
    const row = rowOf(updated.body);
    expect(row.fields["amount"]).toBe(3000);
    expect(row.computed["shareAmount"]).toBe(1000);
    // ID と作成日時は変わらない（店頭が付けた値のままである）
    expect(row.id).toBe(run.ids["dinner"]);
    expect(row.createdAt).toBe("2026-09-16T03:00:00.000Z");
    expect(row.updatedAt).toBe("2026-09-16T03:00:00.000Z");

    const byName = await memberComputed(run);
    expect(byName.get("A")).toEqual({ paid: 3000, owed: 2000, balance: 1000 });
    expect(byName.get("B")).toEqual({ paid: 3000, owed: 2000, balance: 1000 });
    expect(byName.get("C")).toEqual({ paid: 0, owed: 2000, balance: -2000 });
    expect(await settlementLines(run)).toEqual(["C→A 1000", "C→B 1000"]);
  });

  it("続けてタクシーを消すと、A=3000/1000/2000・B/C=0/1000/-1000、精算は B→A 1000・C→A 1000", async () => {
    const run = await runWarikan();
    await createFromAction(run.deps, WARIKAN_INSTANCE, "editExpense", {
      id: run.ids["dinner"] ?? "",
      description: "夕食",
      amount: 3000,
      payer: run.ids["A"] ?? "",
      participants: [run.ids["A"] ?? "", run.ids["B"] ?? "", run.ids["C"] ?? ""],
    });
    const deleted = await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteExpense", {
      id: run.ids["taxi"] ?? "",
    });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.body).toEqual({ entity: "expense", id: run.ids["taxi"], deleted: true });

    // 消した行は一覧から消え、集計と精算は残った行から読み直される
    expect(warikanExpenses(run).map((row) => row.data["description"])).toEqual(["夕食"]);
    const byName = await memberComputed(run);
    expect(byName.get("A")).toEqual({ paid: 3000, owed: 1000, balance: 2000 });
    expect(byName.get("B")).toEqual({ paid: 0, owed: 1000, balance: -1000 });
    expect(byName.get("C")).toEqual({ paid: 0, owed: 1000, balance: -1000 });
    expect(await settlementLines(run)).toEqual(["B→A 1000", "C→A 1000"]);
  });
});

/** 直す入力の土台（夕食を 3000 円に直す形。`patch` で差し替えて、わざと間違えた入力を組む） */
const dinnerInput = (run: WarikanRun, patch: Readonly<Record<string, unknown>> = {}) => ({
  id: run.ids["dinner"] ?? "",
  description: "夕食",
  amount: 3000,
  payer: run.ids["A"] ?? "",
  participants: [run.ids["A"] ?? "", run.ids["B"] ?? "", run.ids["C"] ?? ""],
  ...patch,
});

describe("直す（M1.2）", () => {
  it("不明なレコードは 404、write が無ければ 403（操作そのものが無ければ 404）", async () => {
    const run = await runWarikan();
    expect(
      await createFromAction(run.deps, WARIKAN_INSTANCE, "editExpense", {
        ...dinnerInput(run),
        id: "expense-does-not-exist",
      }),
    ).toEqual({ ok: false, failure: { error: "NOT_FOUND", fields: [], validations: [] } });
    expect(await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteExpense", { id: "nope" })).toEqual({
      ok: false,
      failure: { error: "NOT_FOUND", fields: [], validations: [] },
    });
  });

  it("不正な金額・未知参照・ID や作成日時の書換えは拒否され、元の行と保存日時が変わらない", async () => {
    const run = await runWarikan();
    const before = JSON.stringify(run.records.rows);

    // 負の額（検査の式）
    const negative = await createFromAction(run.deps, WARIKAN_INSTANCE, "editExpense", dinnerInput(run, { amount: 0 }));
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.failure.validations).toEqual(["positiveAmount"]);

    // 小数（精算は整数円だけを扱う。Q18-6）
    const fraction = await createFromAction(run.deps, WARIKAN_INSTANCE, "editExpense", dinnerInput(run, { amount: 333.5 }));
    expect(fraction.ok).toBe(false);
    if (!fraction.ok) expect(fraction.failure.fields).toEqual(["amount"]);

    // 未知参照
    const unknownRef = await createFromAction(
      run.deps,
      WARIKAN_INSTANCE,
      "editExpense",
      dinnerInput(run, { payer: "member-does-not-exist" }),
    );
    expect(unknownRef.ok).toBe(false);
    if (!unknownRef.ok) expect(unknownRef.failure.fields).toEqual(["payer"]);

    // 作成日時の書換え（宣言の項目に無い名前である）
    const createdAt = await createFromAction(
      run.deps,
      WARIKAN_INSTANCE,
      "editExpense",
      dinnerInput(run, { createdAt: "1999-01-01T00:00:00.000Z" }),
    );
    expect(createdAt.ok).toBe(false);
    if (!createdAt.ok) expect(createdAt.failure.fields).toEqual(["createdAt"]);

    // 項目が欠けていれば、未入力として断る（部分更新ではない）
    const partial = await createFromAction(run.deps, WARIKAN_INSTANCE, "editExpense", {
      id: run.ids["dinner"] ?? "",
      amount: 3000,
    });
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.failure.fields).toEqual(["description", "payer", "participants"]);

    // **元の行も保存日時も変わらない**
    expect(JSON.stringify(run.records.rows)).toBe(before);
    const byName = await memberComputed(run);
    expect(byName.get("A")).toEqual({ paid: 6000, owed: 3000, balance: 3000 });
  });

  it("固定時計で成功した更新だけ updatedAt が進む", async () => {
    const run = await runWarikan();
    const later = fixedClock("2026-09-17T09:00:00+09:00");
    const deps: DataApiDeps = { ...run.deps, clock: later };
    const updated = await createFromAction(deps, WARIKAN_INSTANCE, "editExpense", dinnerInput(run, { amount: 3000 }));
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const row = rowOf(updated.body);
    expect(row.createdAt).toBe("2026-09-16T03:00:00.000Z");
    expect(row.updatedAt).toBe("2026-09-17T00:00:00.000Z");
  });
});

describe("消す（M1.2）", () => {
  it("参照の無いメンバーは消せる", async () => {
    const run = await runWarikan();
    const added = await createFromAction(run.deps, WARIKAN_INSTANCE, "addMember", { name: "D" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const id = rowOf(added.body).id;

    expect(await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteMember", { id })).toEqual({
      ok: true,
      status: API_READ_STATUS,
      body: { entity: "member", id, deleted: true },
    });
    expect(run.records.rows.filter((row) => row.entity === "member")).toHaveLength(3);
  });

  it("payer に使われるメンバーも、participants にだけ使われるメンバーも、直接 API へ送ると 409 REFERENCE_IN_USE", async () => {
    const run = await runWarikan();
    // A は payer（夕食）に使われている。C は payer には使われていないが participants にだけ使われている
    for (const name of ["A", "C"] as const) {
      const result = await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteMember", {
        id: run.ids[name] ?? "",
      });
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.failure.error, name).toBe("REFERENCE_IN_USE");
      expect(result.failure.references ?? [], name).not.toHaveLength(0);
      expect(result.failure.references?.every((reference) => reference.entity === "expense")).toBe(true);
      expect(result.failure.references?.every((reference) => reference.count >= 1)).toBe(true);
    }
    // **元の行も参照元も件数も変わらない**
    expect(run.records.rows.filter((row) => row.entity === "member")).toHaveLength(3);
    expect(warikanExpenses(run)).toHaveLength(2);
    expect(run.records.rows.filter((row) => row.entity === "member").map((row) => row.id)).toEqual([
      run.ids["A"],
      run.ids["B"],
      run.ids["C"],
    ]);
  });

  it("参照元をすべて消せば、消せるようになる", async () => {
    const run = await runWarikan();
    // 夕食とタクシーの両方が A を参照している（payer・participants）
    for (const expense of warikanExpenses(run)) {
      expect(await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteExpense", { id: expense.id })).toMatchObject(
        { ok: true },
      );
    }
    expect(
      await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteMember", { id: run.ids["A"] ?? "" }),
    ).toMatchObject({ ok: true });
    expect(run.records.rows.filter((row) => row.entity === "member")).toHaveLength(2);
  });

  it("別インスタンスのレコードは削除を妨げない", async () => {
    // 同じ宣言を使う別のインスタンスに、同じ名前のメンバーと、そのメンバーを指す支出を作る
    const other = await runWarikan();
    const run = await runWarikan();
    expect(other.ids["A"]).not.toBe(run.ids["A"]);

    // このインスタンスの A は自分の支出からしか参照されない（別インスタンスの支出は見えない）
    const deleted = await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteExpense", {
      id: run.ids["taxi"] ?? "",
    });
    expect(deleted.ok).toBe(true);
    const blocked = await createFromAction(run.deps, WARIKAN_INSTANCE, "deleteMember", {
      id: run.ids["A"] ?? "",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      // 参照元は、このインスタンスに残っている夕食 1 件だけである
      expect(blocked.failure.references).toEqual([
        { entity: "expense", field: "payer", count: 1 },
        { entity: "expense", field: "participants", count: 1 },
      ]);
    }
  });

  it("一覧の行は、消せるかの材料（参照元）を載せる（delete を宣言している entity だけ）", async () => {
    const run = await runWarikan();
    const members = await getView(run.deps, WARIKAN_INSTANCE, "memberList");
    if (!members.ok) throw new Error("memberList を読めなかった");
    // A は payer と participants の両方から、B は payer（タクシー）と participants から参照されている
    for (const row of members.body.rows) {
      expect(row.references, String(row.fields["name"])).not.toHaveLength(0);
    }
    // 参照の無いメンバーを足すと、空の並び（＝消せる）になる
    const added = await createFromAction(run.deps, WARIKAN_INSTANCE, "addMember", { name: "D" });
    if (!added.ok) throw new Error("追加できなかった");
    expect(rowOf(added.body).references).toEqual([]);

    // expense も delete を宣言している（まだ誰も参照していないので空である）
    const expenses = await getView(run.deps, WARIKAN_INSTANCE, "expenseList");
    if (!expenses.ok) throw new Error("expenseList を読めなかった");
    for (const row of expenses.body.rows) expect(row.references).toEqual([]);
  });

  it("参照追加と削除を同時に送っても、孤立した参照を残さない", async () => {
    const run = await runWarikan();
    const added = await createFromAction(run.deps, WARIKAN_INSTANCE, "addMember", { name: "D" });
    if (!added.ok) throw new Error("追加できなかった");
    const id = rowOf(added.body).id;

    // **同時に**、そのメンバーを指す支出の追加と、メンバーの削除を送る
    const [expense, deleted] = await Promise.all([
      createFromAction(run.deps, WARIKAN_INSTANCE, "addExpense", {
        description: "おやつ",
        amount: 900,
        payer: id,
        participants: [id],
      }),
      createFromAction(run.deps, WARIKAN_INSTANCE, "deleteMember", { id }),
    ]);

    // どちらかが通り、通ったほうと矛盾しない状態だけが残る（**孤立した参照を残さない**）
    const memberIds = new Set(
      run.records.rows.filter((row) => row.entity === "member").map((row) => row.id),
    );
    for (const row of warikanExpenses(run)) {
      expect(memberIds.has(String(row.data["payer"])), row.id).toBe(true);
      for (const participant of row.data["participants"] as readonly string[]) {
        expect(memberIds.has(participant), row.id).toBe(true);
      }
    }
    if (deleted.ok) expect(expense.ok).toBe(false);
    else expect(expense.ok).toBe(true);
  });
});
