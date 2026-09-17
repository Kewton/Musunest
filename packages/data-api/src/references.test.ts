// 参照（`ref`・参照 list）の検査（Issue #106）の unit テスト。
//
// 静的チェック（spec-engine）は「参照先の entity が宣言に実在するか」までしか見ない。
// **値が入るのは実行のとき**なので、実際の ID が同じインスタンスの参照先に存在するかは
// data-api が保存前に見る（docs/semantics.md「ref」）。ここで確かめるのはその 1 点である。
//
// 断るのは 3 つで、どれも「参照先のレコードが、このインスタンスの、その entity に無い」に潰れる。
//   - 存在しない ID
//   - 別 entity の ID（`expense` の ID を `member` の参照に渡す）
//   - 別インスタンスの ID（1 インスタンス 1 DO なので、この一覧に無い）
import { describe, expect, it } from "vitest";
import type { Entity } from "@musunest/appspec-schema";
import type { RecordData } from "@musunest/app-do";
import { checkReferences, type ReferenceSource } from "./references.js";

const EXPENSE: Entity = {
  name: "expense",
  fields: {
    description: "string",
    payer: { type: "ref", to: "member" },
    participants: { type: "list", of: "member" },
  },
};

/** 参照の項目を持たない entity（このときは参照先を 1 つも読まない） */
const MEMBER: Entity = { name: "member", fields: { name: "string" } };

/** DO の代わり。どの entity を何回読んだかも記録する */
class FakeSource implements ReferenceSource {
  readonly read: string[] = [];

  constructor(private readonly rows: Readonly<Record<string, readonly string[]>>) {}

  async list(entity: string): Promise<readonly { readonly id: string }[]> {
    this.read.push(entity);
    return (this.rows[entity] ?? []).map((id) => ({ id }));
  }
}

/** 3 人のメンバー（m1・m2・m3）がいるインスタンス */
const source = (rows: Readonly<Record<string, readonly string[]>> = { member: ["m1", "m2", "m3"] }) =>
  new FakeSource(rows);

const expense = (data: RecordData): RecordData => ({
  description: "夕食",
  ...data,
});

describe("参照の検査（checkReferences）", () => {
  it("参照先のレコードを指していれば通る", async () => {
    const records = source();
    expect(await checkReferences({ entity: EXPENSE, data: expense({ payer: "m2", participants: ["m1", "m3"] }), records })).toEqual({
      ok: true,
    });
    // 同じ参照先は 1 回だけ読む
    expect(records.read).toEqual(["member"]);
  });

  it("参照の項目が無ければ、参照先を読まずに通る", async () => {
    const records = source();
    expect(await checkReferences({ entity: MEMBER, data: { name: "A" }, records })).toEqual({ ok: true });
    expect(records.read).toEqual([]);
  });

  it("存在しない ID を指す ref は、その項目の名前を返す", async () => {
    expect(
      await checkReferences({
        entity: EXPENSE,
        data: expense({ payer: "member-does-not-exist", participants: ["m1"] }),
        records: source(),
      }),
    ).toEqual({ ok: false, fields: ["payer"] });
  });

  it("参照 list に存在しない ID があれば、その項目の名前を返す", async () => {
    expect(
      await checkReferences({
        entity: EXPENSE,
        data: expense({ payer: "m1", participants: ["m1", "member-does-not-exist"] }),
        records: source(),
      }),
    ).toEqual({ ok: false, fields: ["participants"] });
  });

  it("別 entity の ID は、参照先の一覧に無いので断る", async () => {
    // `expense` の ID（e1）を `member` の参照に渡している
    expect(
      await checkReferences({
        entity: EXPENSE,
        data: expense({ payer: "e1", participants: ["m1"] }),
        records: source({ member: ["m1", "m2"], expense: ["e1"] }),
      }),
    ).toEqual({ ok: false, fields: ["payer"] });
  });

  it("別インスタンスの ID は、この DO の一覧に無いので断る", async () => {
    // 別インスタンスのメンバー（other-1）は、このインスタンスの一覧には無い
    expect(
      await checkReferences({
        entity: EXPENSE,
        data: expense({ payer: "other-1", participants: ["m1"] }),
        records: source({ member: ["m1", "m2", "m3"] }),
      }),
    ).toEqual({ ok: false, fields: ["payer"] });
  });

  it("通らなかった項目を、宣言の順にすべて返す", async () => {
    expect(
      await checkReferences({
        entity: EXPENSE,
        data: expense({ payer: "nobody", participants: ["nobody"] }),
        records: source(),
      }),
    ).toEqual({ ok: false, fields: ["payer", "participants"] });
  });

  it("参照先の一覧が空でも、断るだけで例外にしない", async () => {
    expect(
      await checkReferences({
        entity: EXPENSE,
        data: expense({ payer: "m1", participants: ["m1"] }),
        records: source({ member: [] }),
      }),
    ).toEqual({ ok: false, fields: ["payer", "participants"] });
  });
});
