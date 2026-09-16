// 宣言の entity のレコード（Issue #99）の受入試験。**本物の workerd と本物の SQLite の上で動かす。**
//
// なぜモックにしないか：受入条件が「evict して起こし直しても同じ ID・入力・日時・順序で読める」
// 「実 SQLite の行も照合する」「同じ時刻の複数の行の順序が安定する」であるため。
// DurableObjectState を差し替えた偽物では、偽物が動いた証明にしかならない
// （cmate-worker-development 規律1「空振りのゲート」）。
//
// 経路は dev-entry（テスト専用のハーネス）の HTTP である。DO の RPC は構造化クローンでしか
// 外から呼べず、テストから stub を直接取る口が harness に無いためである。
// 行の照合だけは harness の getDurableObjectStorage で生の SQL を投げて行う——
// メモリ上の写しではなく、実 SQLite の行をそのまま見るため。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { APP_INSTANCE_DO_CLASS_NAME } from "./contract.js";
import type { RecordData, StoredRecord } from "./contract.js";

// tsconfig の lib は ES2022 ＋ workers-types だけなので ImportMeta.url が型に無い。
// このファイルは workerd ではなく Node（vitest）の側で動くので、ここだけ局所的に補う。
const CONFIG_PATH = new URL(
  "../wrangler.jsonc",
  (import.meta as ImportMeta & { url: string }).url,
);
const BOOT_TIMEOUT_MS = 120_000;

/** 固定する時刻（00-open-questions.md Q17：時計を差し込んで採点する）。 */
const T1 = "2026-09-16T03:00:00.000Z";
const T2 = "2026-09-16T04:00:00.000Z";

const server = createTestHarness({ workers: [{ configPath: CONFIG_PATH }] });

/** 1 つのインスタンス（DO）の中の 1 つの entity の入口。`app` が違えば別の DO になる。 */
function path(
  app: string,
  entity: string,
  id?: string,
  stamp: Readonly<Record<string, string>> = {},
): string {
  const params = new URLSearchParams({ app, ...stamp });
  return `/records/${entity}${id === undefined ? "" : `/${id}`}?${params}`;
}

async function created(app: string, entity: string, data: RecordData, stamp?: Readonly<Record<string, string>>): Promise<StoredRecord> {
  const res = await server.fetch(path(app, entity, undefined, stamp), {
    method: "POST",
    body: JSON.stringify(data),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as StoredRecord;
}

async function listed(app: string, entity: string): Promise<StoredRecord[]> {
  const res = await server.fetch(path(app, entity));
  expect(res.status).toBe(200);
  return (await res.json()) as StoredRecord[];
}

async function read(app: string, entity: string, id: string): Promise<StoredRecord | null> {
  const res = await server.fetch(path(app, entity, id));
  expect(res.status).toBe(200);
  return (await res.json()) as StoredRecord | null;
}

async function changed(app: string, entity: string, id: string, data: RecordData, stamp?: Readonly<Record<string, string>>): Promise<StoredRecord | null> {
  const res = await server.fetch(path(app, entity, id, stamp), {
    method: "PUT",
    body: JSON.stringify(data),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as StoredRecord | null;
}

async function removed(app: string, entity: string, id: string): Promise<boolean> {
  const res = await server.fetch(path(app, entity, id), { method: "DELETE" });
  expect(res.status).toBe(200);
  return (await res.json()) as boolean;
}

/** 実 SQLite の行を直接読む。メモリ上の写しではなく、保存された行そのものを見る。 */
async function rawRows(
  app: string,
  query: string,
  ...bindings: string[]
): Promise<Record<string, unknown>[]> {
  const storage = await server
    .getWorker()
    .getDurableObjectStorage(APP_INSTANCE_DO_CLASS_NAME, { name: app });
  return await storage.exec(query, ...bindings);
}

describe("宣言の entity のレコード（workerd 上の実機）", () => {
  beforeAll(async () => {
    await server.listen();
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, BOOT_TIMEOUT_MS);

  it("まだ 1 件も無い entity の一覧は空である", async () => {
    expect(await listed("empty", "expense")).toEqual([]);
  });

  it("同じ DO に 2 件入れると登録順に返り、ID は互いに異なる", async () => {
    const dinner = await created("two-rows", "expense", {
      description: "夕食",
      amount: 6000,
    });
    const taxi = await created("two-rows", "expense", {
      description: "タクシー",
      amount: 3000,
    });

    expect(dinner.id).not.toBe(taxi.id);

    const rows = await listed("two-rows", "expense");
    expect(rows.map((row) => row.data)).toEqual([
      { description: "夕食", amount: 6000 },
      { description: "タクシー", amount: 3000 },
    ]);
    expect(rows.map((row) => row.id)).toEqual([dinner.id, taxi.id]);
    expect(rows.map((row) => row.order)).toEqual([1, 2]);
  });

  it("別の entity と別のインスタンスには、行が現れない", async () => {
    await created("isolation", "expense", { description: "夕食" });
    await created("isolation", "member", { name: "A さん" });

    expect(await listed("isolation", "expense")).toHaveLength(1);
    expect(await listed("isolation", "member")).toHaveLength(1);
    // 同じ DO でも、記録していない entity には行が無い
    expect(await listed("isolation", "activity")).toEqual([]);
    // 別のインスタンス（別の DO）には行が無い
    expect(await listed("isolation-other", "expense")).toEqual([]);
  });

  it("evict して起こし直しても、同じ ID・入力・日時・順序で読める", async () => {
    const dinner: RecordData = { description: "夕食", amount: 6000 };
    const taxi: RecordData = { description: "タクシー", amount: 3000 };
    const first = await created("durable", "expense", dinner, { now: T1, id: "expense-1" });
    const second = await created("durable", "expense", taxi, { now: T1, id: "expense-2" });

    await server
      .getWorker()
      .evictDurableObject(APP_INSTANCE_DO_CLASS_NAME, { name: "durable" });

    expect(await listed("durable", "expense")).toEqual([first, second]);

    // 実 SQLite の行と照合する（メモリだけで成功させない）
    const rows = await rawRows(
      "durable",
      `SELECT entity, id, data, created_at, updated_at, ordering
         FROM records WHERE entity = ? ORDER BY ordering`,
      "expense",
    );
    expect(rows).toEqual([
      {
        entity: "expense",
        id: "expense-1",
        data: JSON.stringify(dinner),
        created_at: T1,
        updated_at: T1,
        ordering: 1,
      },
      {
        entity: "expense",
        id: "expense-2",
        data: JSON.stringify(taxi),
        created_at: T1,
        updated_at: T1,
        ordering: 2,
      },
    ]);
  });

  it("時計を固定すると日時は指定した値になり、更新しても ID と作成日時と登録順は変わらない", async () => {
    const input: RecordData = { description: "夕食", amount: 6000 };
    const before = await created("clock", "expense", input, { now: T1, id: "expense-1" });
    expect(before.createdAt).toBe(T1);
    expect(before.updatedAt).toBe(T1);
    expect(before.order).toBe(1);

    const after = await changed("clock", "expense", "expense-1", { amount: 3000 }, { now: T2 });
    expect(after).not.toBeNull();
    expect(after?.id).toBe("expense-1");
    expect(after?.createdAt).toBe(T1);
    // 更新日時だけが進む
    expect(after?.updatedAt).toBe(T2);
    expect(after?.order).toBe(1);
    expect(after?.data).toEqual({ amount: 3000 });

    expect(await read("clock", "expense", "expense-1")).toEqual(after);
  });

  it("同じ時刻に複数件を入れても、順序は登録順で安定する", async () => {
    const first = await created("same-time", "expense", { description: "夕食" }, { now: T1 });
    const second = await created("same-time", "expense", { description: "タクシー" }, { now: T1 });
    const third = await created("same-time", "expense", { description: "おやつ" }, { now: T1 });

    // 3 件とも同じ時刻である（時刻だけでは並べられない）
    expect([first.createdAt, second.createdAt, third.createdAt]).toEqual([T1, T1, T1]);

    const rows = await listed("same-time", "expense");
    expect(rows.map((row) => row.data)).toEqual([
      { description: "夕食" },
      { description: "タクシー" },
      { description: "おやつ" },
    ]);
    expect(rows.map((row) => row.order)).toEqual([1, 2, 3]);
    // 読み直しても同じ並び
    expect((await listed("same-time", "expense")).map((row) => row.id)).toEqual(
      rows.map((row) => row.id),
    );

    // 順序を決めているのは実 SQLite の登録順の列である
    const raw = await rawRows(
      "same-time",
      "SELECT id, created_at, ordering FROM records WHERE entity = ? ORDER BY ordering",
      "expense",
    );
    expect(raw).toEqual([
      { id: first.id, created_at: T1, ordering: 1 },
      { id: second.id, created_at: T1, ordering: 2 },
      { id: third.id, created_at: T1, ordering: 3 },
    ]);
  });

  it("無い行の取得・更新は null、無い行の削除は false、ある行の削除は true", async () => {
    expect(await read("absent", "expense", "nope")).toBeNull();
    expect(await changed("absent", "expense", "nope", { amount: 1 })).toBeNull();
    expect(await removed("absent", "expense", "nope")).toBe(false);

    await created("absent", "expense", { amount: 1 }, { id: "there" });
    expect(await removed("absent", "expense", "there")).toBe(true);
    expect(await removed("absent", "expense", "there")).toBe(false);
    expect(await read("absent", "expense", "there")).toBeNull();
  });

  it("別 entity の ID を指定した更新・削除は、元の行を変えない", async () => {
    const expense = await created("cross-entity", "expense", { description: "夕食" }, {
      now: T1,
      id: "shared-id",
    });
    const member = await created("cross-entity", "member", { name: "A さん" }, {
      now: T1,
      id: "shared-id",
    });
    // ID が同じでも別の行である（主キーは entity と ID の組）
    expect(member.id).toBe(expense.id);

    const rewritten = await changed("cross-entity", "member", "shared-id", { name: "B さん" }, {
      now: T2,
    });
    expect(rewritten?.data).toEqual({ name: "B さん" });
    expect(await read("cross-entity", "expense", "shared-id")).toEqual(expense);

    expect(await removed("cross-entity", "member", "shared-id")).toBe(true);
    expect(await read("cross-entity", "expense", "shared-id")).toEqual(expense);
    expect(await listed("cross-entity", "expense")).toEqual([expense]);
  });

  it("保存するのは入力だけで、computed の値は入らない", async () => {
    const input: RecordData = {
      description: "夕食",
      amount: 6000,
      participants: ["A", "B"],
    };
    const row = await created("input-only", "expense", input, { now: T1, id: "expense-1" });

    expect(row.data).toEqual(input);
    expect(Object.keys(row.data)).toEqual(Object.keys(input));
    expect(row.data).not.toHaveProperty("shareAmount");
    expect(row.data).not.toHaveProperty("createdAt");

    const raw = await rawRows(
      "input-only",
      "SELECT data FROM records WHERE entity = ? AND id = ?",
      "expense",
      "expense-1",
    );
    expect(raw).toEqual([{ data: JSON.stringify(input) }]);
  });

  it("入力に id や createdAt が入っていても、行の ID と日時は保存境界が付けた値になる", async () => {
    const row = await created(
      "stamp-wins",
      "expense",
      { id: "input", createdAt: "1999-01-01T00:00:00.000Z", amount: 1 },
      { now: T1, id: "boundary" },
    );

    expect(row.id).toBe("boundary");
    expect(row.createdAt).toBe(T1);
    // 入力の id では引けない（入力の値は行の ID を決めない）
    expect(await read("stamp-wins", "expense", "input")).toBeNull();
    expect(await read("stamp-wins", "expense", "boundary")).toEqual(row);
  });
});
