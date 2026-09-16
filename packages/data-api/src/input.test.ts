// 入力の検査（Issue #102）の unit テスト。
//
// **見本「支出の記録」の宣言をそのまま使う**（手で書いた写しを使わない）。入力の検査は宣言の
// 項目の型だけを見るので、宣言を写すと、宣言が変わったときにテストだけが古い意味で緑になる。
//
// 確かめるのは、意味の文書（docs/semantics.md「validation」「action」）と Q18-2 の決めごとである。
//   1. 型の検査：項目の過不足と型。通らない項目を**すべて**返し、そのとき検査の式は評価しない
//   2. 計算：型の検査を通った入力で computed を出す
//   3. 検査の式：宣言の順にすべて評価し、真にならなかった名前を宣言の順に返す
// 併せて、数の型が**有限の数だけ**を受け取ること、list が空と重複と非文字列を拒否することを見る。
import { describe, expect, it } from "vitest";
import { APPSPEC_SCHEMA_VERSION } from "@musunest/appspec-schema";
import type { Entity, NormalizedAppSpec } from "@musunest/appspec-schema";
import { sampleSpecFile } from "@musunest/appspec-schema/files";
import { checkSpec, fixedClock } from "@musunest/spec-engine";
import { checkInput, checkInputTypes } from "./input.js";

interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFs;

/** 見本の宣言を、静的チェックを通した「正規化した JSON」の形にする（Issue #98） */
function sampleApp(): NormalizedAppSpec {
  const checked = checkSpec(fs.readFileSync(sampleSpecFile("expense-log"), "utf8"));
  if (!checked.ok) throw new Error("見本が静的チェックに通らない");
  return { schemaVersion: APPSPEC_SCHEMA_VERSION, sourceSha256: "a".repeat(64), spec: checked.spec };
}

const APP = sampleApp();
const CLOCK = fixedClock("2026-09-16T12:00:00+09:00");

function entityOf(name: string): Entity {
  const entity = APP.spec.entities.find((candidate) => candidate.name === name);
  if (entity === undefined) throw new Error(`entity ${name} が無い`);
  return entity;
}

const EXPENSE = entityOf("expense");

/** 通る入力（シナリオの 1 手目）。検査の対象を差し替えるときの土台にする */
const VALID: Readonly<Record<string, unknown>> = {
  description: "夕食",
  amount: 6600,
  discount: 600,
  payer: "A",
  participants: ["A", "B", "C"],
};

/** 断られた入力の、通らなかった項目の名前（通った場合は空） */
const fieldsOf = (input: Readonly<Record<string, unknown>>): readonly string[] => {
  const result = checkInputTypes(EXPENSE, input);
  return result.ok ? [] : result.fields;
};

/** 1 つの項目を除いた入力（項目を落としたことをテストの意図として残す） */
const without = (name: string): Record<string, unknown> => {
  const input: Record<string, unknown> = { ...VALID };
  delete input[name];
  return input;
};

describe("項目の過不足と型（checkInputTypes）", () => {
  it("宣言した項目をちょうど全部持つ入力は通る。保存する値は宣言の順に並ぶ", () => {
    const result = checkInputTypes(EXPENSE, VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data)).toEqual([
      "description",
      "amount",
      "discount",
      "payer",
      "participants",
    ]);
    expect(result.data).toEqual(VALID);
  });

  it("足りない項目を返す（M1.1 の項目はすべて必須）", () => {
    expect(fieldsOf(without("discount"))).toEqual(["discount"]);
    expect(fieldsOf(without("participants"))).toEqual(["participants"]);
  });

  it("知らない項目を入力に含めたら断る", () => {
    expect(fieldsOf({ ...VALID, memo: "駅前" })).toEqual(["memo"]);
  });

  it("計算の値を入力に含めたら断る（未知の項目として扱う）", () => {
    expect(fieldsOf({ ...VALID, shareAmount: 3000 })).toEqual(["shareAmount"]);
  });

  it("店頭が付ける値を入力に含めたら断る（未知の項目として扱う）", () => {
    expect(fieldsOf({ ...VALID, createdAt: "2026-09-16T12:00:00+09:00" })).toEqual(["createdAt"]);
    expect(fieldsOf({ ...VALID, id: "expense-1" })).toEqual(["id"]);
  });

  it("型の違う項目が 2 つなら、2 つとも返す（宣言の順）", () => {
    expect(fieldsOf({ ...VALID, amount: "x", participants: [] })).toEqual([
      "amount",
      "participants",
    ]);
  });

  it("足りない項目と型の違う項目が混ざっても、返す順は宣言の順である", () => {
    expect(fieldsOf({ ...without("payer"), amount: "x" })).toEqual(["amount", "payer"]);
  });

  it("文字列は空でも受け取る（M1.1 に必須の指定は無い）", () => {
    const result = checkInputTypes(EXPENSE, { ...VALID, description: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["description"]).toBe("");
  });

  it("数は有限の数だけを受け取る（文字列は数へ読み替えない）", () => {
    // JSON.stringify で Infinity が null に化けた値も、数ではないので落ちる
    expect(fieldsOf({ ...VALID, amount: "3000" })).toEqual(["amount"]);
    expect(fieldsOf({ ...VALID, amount: Number.POSITIVE_INFINITY })).toEqual(["amount"]);
    expect(fieldsOf({ ...VALID, amount: Number.NaN })).toEqual(["amount"]);
    expect(fieldsOf({ ...VALID, discount: null })).toEqual(["discount"]);
    expect(checkInputTypes(EXPENSE, { ...VALID, amount: 0 }).ok).toBe(true);
    // 整数に限らない（端数の扱いは M1.2 で決める）
    expect(checkInputTypes(EXPENSE, { ...VALID, amount: 12.5 }).ok).toBe(true);
  });

  it("list は空の並びを拒否する（Q18-2）", () => {
    expect(fieldsOf({ ...VALID, participants: [] })).toEqual(["participants"]);
  });

  it("list は同じ文字列が 2 回ある並びを拒否する", () => {
    expect(fieldsOf({ ...VALID, participants: ["A", "A"] })).toEqual(["participants"]);
  });

  it("list の要素が文字列でなければ拒否する", () => {
    expect(fieldsOf({ ...VALID, participants: ["A", 1] })).toEqual(["participants"]);
    expect(fieldsOf({ ...VALID, participants: [1] })).toEqual(["participants"]);
    expect(fieldsOf({ ...VALID, participants: [null] })).toEqual(["participants"]);
    expect(fieldsOf({ ...VALID, participants: ["A", "B", 3] })).toEqual(["participants"]);
  });

  it("list でなければ拒否する（文字列も含む）", () => {
    expect(fieldsOf({ ...VALID, participants: "A" })).toEqual(["participants"]);
  });

  it("並びの順は入力の順のまま保存する", () => {
    const result = checkInputTypes(EXPENSE, { ...VALID, participants: ["C", "A", "B"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["participants"]).toEqual(["C", "A", "B"]);
  });

  it("入力のオブジェクトを書き換えない", () => {
    const input: Record<string, unknown> = { ...VALID };
    const before = JSON.stringify(input);
    checkInputTypes(EXPENSE, input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("型 → 計算 → 検査の順（checkInput）", () => {
  it("型で断ったら、検査の式を評価しない（validations は空）", () => {
    // discount は負（nonNegativeDiscount に反する）が、amount が文字列なので型で断る。
    // 「断った理由は型だけ」であることを、validations が空であることで確かめる
    const decided = checkInput({
      app: APP,
      entity: EXPENSE,
      input: { ...VALID, amount: "0", discount: -1 },
      clock: CLOCK,
    });
    expect(decided).toEqual({ ok: false, fields: ["amount"], validations: [] });
  });

  it("型が通れば、通らない検査の名前を宣言の順にすべて返す", () => {
    const decided = checkInput({
      app: APP,
      entity: EXPENSE,
      input: { ...VALID, amount: 0, discount: -100 },
      clock: CLOCK,
    });
    expect(decided).toEqual({
      ok: false,
      fields: [],
      validations: ["positiveAmount", "nonNegativeDiscount"],
    });
  });

  it("検査が 1 つだけ通らないときは、その名前だけを返す（宣言の順）", () => {
    const decided = checkInput({
      app: APP,
      entity: EXPENSE,
      input: { ...VALID, amount: 1000, discount: -1 },
      clock: CLOCK,
    });
    expect(decided).toEqual({ ok: false, fields: [], validations: ["nonNegativeDiscount"] });
  });

  it("通った入力には、計算の値を付けて返す（保存はしない）", () => {
    const decided = checkInput({ app: APP, entity: EXPENSE, input: VALID, clock: CLOCK });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.computed).toEqual({ paidAmount: 6000, headcount: 3, shareAmount: 2000 });
    // 保存する値に計算の名前は入らない
    expect(Object.keys(decided.data)).not.toContain("paidAmount");
  });

  it("割引が金額を超えても保存し、払った額は 0 にする（計算は保存の可否を決めない）", () => {
    const decided = checkInput({
      app: APP,
      entity: EXPENSE,
      input: { ...VALID, description: "コーヒー", amount: 400, discount: 500, participants: ["C"] },
      clock: CLOCK,
    });
    expect(decided.ok).toBe(true);
    if (decided.ok) {
      expect(decided.computed).toEqual({ paidAmount: 0, headcount: 1, shareAmount: 0 });
    }
  });

  it("計算の値は時計に依らない（M1.1 の式は日付を読まない。Q17）", () => {
    const other = checkInput({
      app: APP,
      entity: EXPENSE,
      input: VALID,
      clock: fixedClock("1999-01-01T00:00:00Z"),
    });
    const base = checkInput({ app: APP, entity: EXPENSE, input: VALID, clock: CLOCK });
    expect(other).toEqual(base);
  });
});
