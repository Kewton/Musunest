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

// ── 参照（ref）と参照 list（M1.2。Issue #106） ──────────────────────
//
// 型の検査が見るのは「空でない文字列（ID）の並びか」までである。**その ID が実在するかは
// references.ts が見る**（二段構え）。ここでは、空・重複・非文字列を型の検査で断ることを確かめる。

/** 見本 warikan の宣言（参照と参照 list を持つ） */
function warikanApp(): NormalizedAppSpec {
  const checked = checkSpec(fs.readFileSync(sampleSpecFile("warikan"), "utf8"));
  if (!checked.ok) throw new Error("warikan が静的チェックに通らない");
  return { schemaVersion: APPSPEC_SCHEMA_VERSION, sourceSha256: "b".repeat(64), spec: checked.spec };
}

const WARIKAN_EXPENSE_ENTITY = warikanApp().spec.entities.find((entry) => entry.name === "expense");
if (WARIKAN_EXPENSE_ENTITY === undefined) throw new Error("warikan に expense が無い");
const REF_EXPENSE = WARIKAN_EXPENSE_ENTITY;

const VALID_REF: Readonly<Record<string, unknown>> = {
  description: "夕食",
  amount: 6000,
  payer: "m1",
  participants: ["m1", "m2"],
};

const refFieldsOf = (input: Readonly<Record<string, unknown>>): readonly string[] => {
  const result = checkInputTypes(REF_EXPENSE, input);
  return result.ok ? [] : result.fields;
};

describe("参照（ref）と参照 list（checkInputTypes）", () => {
  it("ID の文字列と、その並びは通る（実在の確認は references.ts が行う）", () => {
    const result = checkInputTypes(REF_EXPENSE, VALID_REF);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(VALID_REF);
  });

  it("ref が空文字なら断る（空文字は ID にならない）", () => {
    expect(refFieldsOf({ ...VALID_REF, payer: "" })).toEqual(["payer"]);
  });

  it("ref が文字列でなければ断る", () => {
    expect(refFieldsOf({ ...VALID_REF, payer: 1 })).toEqual(["payer"]);
    expect(refFieldsOf({ ...VALID_REF, payer: ["m1"] })).toEqual(["payer"]);
    expect(refFieldsOf({ ...VALID_REF, payer: null })).toEqual(["payer"]);
  });

  it("参照 list は空の並びを断る（Q18-2 を参照の並びでも保つ）", () => {
    expect(refFieldsOf({ ...VALID_REF, participants: [] })).toEqual(["participants"]);
  });

  it("参照 list は同じ ID が 2 回ある並びを断る", () => {
    expect(refFieldsOf({ ...VALID_REF, participants: ["m1", "m1"] })).toEqual(["participants"]);
  });

  it("参照 list の要素が文字列でなければ断る", () => {
    expect(refFieldsOf({ ...VALID_REF, participants: ["m1", 1] })).toEqual(["participants"]);
    expect(refFieldsOf({ ...VALID_REF, participants: [null] })).toEqual(["participants"]);
  });

  it("参照 list の順は入力の順のまま保存する", () => {
    const result = checkInputTypes(REF_EXPENSE, { ...VALID_REF, participants: ["m3", "m1"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["participants"]).toEqual(["m3", "m1"]);
  });

  it("型で断ったら、参照の検査に進む値を作らない（checkInput は型で止まる）", () => {
    const decided = checkInput({
      app: warikanApp(),
      entity: REF_EXPENSE,
      input: { ...VALID_REF, participants: [] },
      clock: CLOCK,
    });
    expect(decided).toEqual({ ok: false, fields: ["participants"], validations: [] });
  });
});

// ── 選択肢（enum）と既定値（default）（M1.3。Issue #154） ──────────────
//
// **宣言に無い値を断るのは data-api だけである**（画面が選択肢を絞るのは守りではない。
// `CLAUDE.md` の不変条件）。既定値は**保存の時点で**入る——画面が項目を送ってこなくても入る
// （docs/semantics.md「enum」「default」）。
//
// 見本 `samples/task-board/` は #159 が置く。ここでは、その見本と同じ形の最小の宣言を組み立てる
// （選択肢の項目 status には既定値があり、既定値の無い項目 memo を 1 つ持つ）。

const TASK_SOURCE = [
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
  "      memo: string",
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

function taskApp(): NormalizedAppSpec {
  const checked = checkSpec(TASK_SOURCE);
  if (!checked.ok) throw new Error("選択肢の宣言が静的チェックに通らない");
  return { schemaVersion: APPSPEC_SCHEMA_VERSION, sourceSha256: "c".repeat(64), spec: checked.spec };
}

const TASK_ENTITY = taskApp().spec.entities.find((entry) => entry.name === "task");
if (TASK_ENTITY === undefined) throw new Error("選択肢の宣言に task が無い");

/** 通る入力の土台（status は省略できる。既定値があるためである） */
const TASK_VALID: Readonly<Record<string, unknown>> = { title: "宿の予約", memo: "" };

describe("選択肢（enum）と既定値（default）（checkInputTypes・M1.3）", () => {
  const taskFieldsOf = (input: Readonly<Record<string, unknown>>): readonly string[] => {
    const result = checkInputTypes(TASK_ENTITY, input);
    return result.ok ? [] : result.fields;
  };

  it("options のキーは通る。保存されるのは表示名ではなくキーである（受入条件）", () => {
    const result = checkInputTypes(TASK_ENTITY, { ...TASK_VALID, status: "doing" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ title: "宿の予約", status: "doing", memo: "" });
  });

  it("options に無い値は断る（data-api が唯一の権限強制点である。受入条件）", () => {
    expect(taskFieldsOf({ ...TASK_VALID, status: "archived" })).toEqual(["status"]);
    // 表示名は保存される値ではない（見せる言葉と、保存する値を混同しない）
    expect(taskFieldsOf({ ...TASK_VALID, status: "未着手" })).toEqual(["status"]);
    expect(taskFieldsOf({ ...TASK_VALID, status: "" })).toEqual(["status"]);
    expect(taskFieldsOf({ ...TASK_VALID, status: 1 })).toEqual(["status"]);
    expect(taskFieldsOf({ ...TASK_VALID, status: ["todo"] })).toEqual(["status"]);
    expect(taskFieldsOf({ ...TASK_VALID, status: null })).toEqual(["status"]);
  });

  it("未入力なら既定値が入る（画面が送ってこなくても入る。受入条件）", () => {
    const result = checkInputTypes(TASK_ENTITY, TASK_VALID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data["status"]).toBe("todo");
  });

  it("既定値の無い項目は未入力のままである（M1.1 のとおり断る。受入条件）", () => {
    const result = checkInputTypes(TASK_ENTITY, { title: "宿の予約", status: "todo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields).toEqual(["memo"]);
  });

  it("送られた値がキーでなければ、既定値に読み替えない（黙って別の値にしない）", () => {
    // status は「送られている」ので、既定値 todo に読み替えずに断る
    const result = checkInputTypes(TASK_ENTITY, { ...TASK_VALID, status: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields).toEqual(["status"]);
  });

  it("入力のオブジェクトを書き換えない（既定値を入れても）", () => {
    const input: Record<string, unknown> = { title: "宿の予約", memo: "" };
    const before = JSON.stringify(input);
    checkInputTypes(TASK_ENTITY, input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("checkInput は、キーでない値なら型の検査で止まる（検査の式を評価しない）", () => {
    const decided = checkInput({
      app: taskApp(),
      entity: TASK_ENTITY,
      input: { ...TASK_VALID, status: "archived" },
      clock: CLOCK,
    });
    expect(decided).toEqual({ ok: false, fields: ["status"], validations: [] });
  });

  it("checkInput は、未入力の選択肢に既定値を入れて通す", () => {
    const decided = checkInput({
      app: taskApp(),
      entity: TASK_ENTITY,
      input: TASK_VALID,
      clock: CLOCK,
    });
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.data["status"]).toBe("todo");
  });
});
