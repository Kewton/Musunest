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
import { API_CREATED_STATUS, API_READ_STATUS, APPSPEC_SCHEMA_VERSION } from "@musunest/appspec-schema";
import type { ApiViewBody, NormalizedAppSpec } from "@musunest/appspec-schema";
import { sampleScenarioFile, sampleSpecFile } from "@musunest/appspec-schema/files";
import type { AppRecord } from "@musunest/control-plane";
import type { RecordData, RecordStamp, StoredRecord } from "@musunest/app-do";
import type { Clock } from "@musunest/spec-engine";
import { fixedClock, normalizeSpec } from "@musunest/spec-engine";
import type { DataApiDeps, InstanceRegistry, NormalizedSpecStore, RecordStore } from "./app-api.js";
import { createFromAction, getSpec, getView, readNormalizedApp } from "./app-api.js";

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

/** DO の代わり。**保存だけ**を受け持ち、判定は持たない（app-do と同じ分担） */
class FakeRecordStore implements RecordStore {
  readonly rows: StoredRecord[] = [];
  async create(entity: string, data: RecordData, stamp: RecordStamp): Promise<StoredRecord> {
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
    return record;
  }
  async list(entity: string): Promise<StoredRecord[]> {
    return this.rows.filter((record) => record.entity === entity);
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
    expect(result.body.createdAt).toBe("2026-09-16T03:00:00.000Z");
    expect(result.body.updatedAt).toBe("2026-09-16T03:00:00.000Z");
    expect(h.records.rows[0]?.createdAt).toBe("2026-09-16T03:00:00.000Z");
  });

  it("別の時刻を差し込めば、別の保存日時になる", async () => {
    const h = harness(fixedClock("2000-01-02T00:00:00Z"));
    const result = await createFromAction(h.deps, INSTANCE, "addExpense", STEPS[0]?.input ?? {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.createdAt).toBe("2000-01-02T00:00:00.000Z");
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
