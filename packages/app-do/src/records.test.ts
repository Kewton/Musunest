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
import type {
  GuardedCreate,
  GuardedDelete,
  RecordData,
  ReferenceExpectation,
  ReferenceGuard,
  StoredRecord,
} from "./contract.js";

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
  /** 参照の期待・参照の確認（M1.2）。付けると、参照を同じ呼出の中で確かめる版になる */
  guard?: unknown,
): string {
  const params = new URLSearchParams({ app, ...stamp });
  if (guard !== undefined) params.set("guard", JSON.stringify(guard));
  return `/records/${entity}${id === undefined ? "" : `/${id}`}?${params}`;
}

/** 参照の期待つきの追加（M1.2）。**確かめることと書くことが 1 つの呼出**である */
async function createdGuarded(
  app: string,
  entity: string,
  data: RecordData,
  expectations: readonly ReferenceExpectation[],
  stamp?: Readonly<Record<string, string>>,
): Promise<GuardedCreate> {
  const res = await server.fetch(path(app, entity, undefined, stamp, expectations), {
    method: "POST",
    body: JSON.stringify(data),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GuardedCreate;
}

/** 参照の確認つきの削除（M1.2）。**数えることと消すことが 1 つの呼出**である */
async function removedGuarded(
  app: string,
  entity: string,
  id: string,
  guards: readonly ReferenceGuard[],
): Promise<GuardedDelete> {
  const res = await server.fetch(path(app, entity, id, {}, guards), { method: "DELETE" });
  expect(res.status).toBe(200);
  return (await res.json()) as GuardedDelete;
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

  // ── 参照されている行は消せない（M1.2。Issue #109） ──────────────────
  //
  // 消せるかどうかは**保存済みの行**に依るので、静的チェックには判定できない（03 §5.1）。
  // ここで確かめるのは、**確かめることと書くことが 1 つの呼出の中で行われる**ことである——
  // 「一覧を読んでから消す」の 2 回の呼出だと、その間に参照が足されて孤立した参照が残る。

  /** 見本 warikan の参照（`expense.payer` は `ref`、`expense.participants` は参照 list） */
  const memberGuards: readonly ReferenceGuard[] = [
    { entity: "expense", field: "payer", list: false },
    { entity: "expense", field: "participants", list: true },
  ];

  /** 追加するときの参照の期待（書くのと同じ呼出で見る） */
  const memberExpectations: readonly ReferenceExpectation[] = [
    { field: "payer", to: "member", list: false },
    { field: "participants", to: "member", list: true },
  ];

  it("参照先が実在すれば書け、実在しなければ書かずに項目名を返す", async () => {
    const a = await createdGuarded(
      "guarded-create",
      "member",
      { name: "A" },
      [],
      { now: T1, id: "m1" },
    );
    expect(a).toMatchObject({ ok: true });

    const ok = await createdGuarded(
      "guarded-create",
      "expense",
      { amount: 1000, payer: "m1", participants: ["m1"] },
      memberExpectations,
      { now: T1, id: "e1" },
    );
    expect(ok.ok).toBe(true);

    // 存在しない ID は、書かずに通らなかった項目の名前を返す（宣言の順）
    const missing = await createdGuarded(
      "guarded-create",
      "expense",
      { amount: 2000, payer: "m-nobody", participants: ["m1", "m-nobody"] },
      memberExpectations,
      { now: T1, id: "e2" },
    );
    expect(missing).toEqual({
      ok: false,
      reason: "REFERENCE_NOT_FOUND",
      fields: ["payer", "participants"],
    });
    // 書いていない（孤立した参照を残さない）
    expect(await listed("guarded-create", "expense")).toHaveLength(1);
  });

  it("参照が無ければ消せて、行が 1 つ減る", async () => {
    const member = await created("guarded-free", "member", { name: "A" }, { now: T1, id: "m1" });
    const result = await removedGuarded("guarded-free", "member", "m1", memberGuards);
    expect(result).toEqual({ ok: true, record: member });
    expect(await listed("guarded-free", "member")).toEqual([]);
  });

  it("payer だけで参照されていても、participants だけで参照されていても、消せない（参照元と件数つき）", async () => {
    await created("guarded-payer", "member", { name: "A" }, { now: T1, id: "m1" });
    await created("guarded-payer", "member", { name: "B" }, { now: T1, id: "m2" });
    await created(
      "guarded-payer",
      "expense",
      { amount: 6000, payer: "m1", participants: ["m1", "m2"] },
      { now: T1, id: "e1" },
    );

    const result = await removedGuarded("guarded-payer", "member", "m1", memberGuards);
    expect(result).toEqual({
      ok: false,
      reason: "REFERENCE_IN_USE",
      references: [
        { entity: "expense", field: "payer", list: false, count: 1 },
        { entity: "expense", field: "participants", list: true, count: 1 },
      ],
    });
    // 元の行は変わらない（消えていない）
    expect(await listed("guarded-payer", "member")).toHaveLength(2);

    // 参照元を消せば、消せるようになる
    expect(await removed("guarded-payer", "expense", "e1")).toBe(true);
    const after = await removedGuarded("guarded-payer", "member", "m1", memberGuards);
    expect(after.ok).toBe(true);
  });

  it("participants にだけ使われている行も消せない（外すと消せる）", async () => {
    await created("guarded-list", "member", { name: "C" }, { now: T1, id: "m3" });
    await created("guarded-list", "member", { name: "D" }, { now: T1, id: "m4" });
    // payer は D、participants にだけ C が入っている（payer からの参照は無い）
    await created(
      "guarded-list",
      "expense",
      { amount: 3000, payer: "m4", participants: ["m3", "m4"] },
      { now: T1, id: "e1" },
    );

    expect(await removedGuarded("guarded-list", "member", "m3", memberGuards)).toEqual({
      ok: false,
      reason: "REFERENCE_IN_USE",
      references: [{ entity: "expense", field: "participants", list: true, count: 1 }],
    });

    // participants から外す（直す）と、消せるようになる
    expect(
      await changed("guarded-list", "expense", "e1", {
        amount: 3000,
        payer: "m4",
        participants: ["m4"],
      }),
    ).not.toBeNull();
    expect((await removedGuarded("guarded-list", "member", "m3", memberGuards)).ok).toBe(true);
    expect((await listed("guarded-list", "member")).map((row) => row.id)).toEqual(["m4"]);
  });

  it("無い行の削除は NOT_FOUND（ほかの行は変えない）", async () => {
    await created("guarded-absent", "member", { name: "A" }, { now: T1, id: "m1" });
    expect(await removedGuarded("guarded-absent", "member", "nope", memberGuards)).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    expect(await listed("guarded-absent", "member")).toHaveLength(1);
  });

  it("参照の追加と削除を同時に送っても、孤立した参照を残さない", async () => {
    // メンバーを 1 人作り、そのメンバーを指す支出の追加と、メンバーの削除を**同時に**送る。
    // DO は要求を直列に処理し、どちらも「確かめてから書く」ので、
    //   支出が先に着けば削除は断られ（参照が 1 件ある）、
    //   削除が先に着けば支出は参照先が無いので断られる。
    // **どちらの順でも、payer が存在しない行は残らない。**
    for (let round = 0; round < 5; round += 1) {
      const app = `guarded-race-${round}`;
      await created(app, "member", { name: "A" }, { now: T1, id: "m1" });

      const [, deleted] = await Promise.all([
        createdGuarded(
          app,
          "expense",
          { amount: 1000, payer: "m1", participants: ["m1"] },
          memberExpectations,
          { now: T1, id: "e1" },
        ),
        removedGuarded(app, "member", "m1", memberGuards),
      ]);

      const members = new Set((await listed(app, "member")).map((row) => row.id));
      const expenses = await listed(app, "expense");
      // 孤立した参照が無い（支出が指す payer の行が、必ず残っている）
      for (const expense of expenses) {
        expect(members.has(String(expense.data["payer"])), expense.id).toBe(true);
      }
      // どちらかは通っている（両方断られることはない。先に着いたほうが勝つ）
      if (deleted.ok) expect(expenses).toHaveLength(0);
      else expect(expenses).toHaveLength(1);
    }
  });
});
