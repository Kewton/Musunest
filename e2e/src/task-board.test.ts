// runner（task-board.ts）の試験（Issue #159）。**mock の client で、実環境には一切届かない。**
//
// 見るのは4つである。
//   1. SHA と版が一致すれば、メンバー A・B・C とタスク 3 つをそろえ、時計に依存しない値
//      （ボードの列・タスクの項目・openTasks）を採点し、`finish` を実行して片付ける
//   2. **不一致・版違いでは、1つも書かない**（採点も後片付けもしない）
//   3. 途中の POST・一覧の照合・finish を失敗させても、**後片付けは呼ばれる**
//   4. 後片付けが失敗したら、成功と報告しない

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createFakeTaskBoardApi,
  seededMembers,
  seededTasks,
  type FakeTaskBoardApi,
  type FakeTaskBoardOptions,
} from "./__tests__/task-board.js";
import { SAMPLE_FILE, runTaskBoard, type TaskBoardResult } from "./task-board.js";
import { DRAFT_SCHEMA_VERSION, sha256Hex } from "./warikan.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INSTANCE = "m12-e2e-task-board-test";
const SOURCE = readFileSync(join(ROOT, SAMPLE_FILE), "utf8");
const SOURCE_SHA = await sha256Hex(SOURCE);

interface Harness {
  readonly api: FakeTaskBoardApi;
  readonly out: string[];
  readonly err: string[];
  run(options?: { readonly source?: string; readonly instanceId?: string }): Promise<TaskBoardResult>;
}

function harness(options: FakeTaskBoardOptions): Harness {
  const api = createFakeTaskBoardApi(options);
  const out: string[] = [];
  const err: string[] = [];
  return {
    api,
    out,
    err,
    run: (runOptions = {}) =>
      runTaskBoard({
        client: api.client,
        instanceId: runOptions.instanceId ?? INSTANCE,
        source: runOptions.source ?? SOURCE,
        expectedSchemaVersion: DRAFT_SCHEMA_VERSION,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      }),
  };
}

const countOf = (api: FakeTaskBoardApi, name: string): number =>
  api.actions().filter((action) => action === name).length;

describe("runTaskBoard：原本の照合と採点", () => {
  it("SHA と版が一致すれば、A・B・C とタスクをそろえ、採点して finish し、片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA });
    const result = await h.run();

    expect(result, h.out.join("\n")).toEqual({ ok: true, reason: "" });
    expect(countOf(h.api, "addMember")).toBe(3);
    expect(countOf(h.api, "addTask")).toBe(3);
    expect(countOf(h.api, "finish")).toBe(1);
    // 専用データが残っていない（タスクは消し、メンバーは再利用する）
    expect(h.api.tasks()).toEqual([]);
    expect(h.api.members()).toHaveLength(3);
    expect(h.out.join("\n")).toContain("採点した");
    expect(h.out.join("\n")).toContain("finish");
  });

  it("原本 SHA-256 が一致しなければ、1つも書かずに止まる（採点も後片付けもしない）", async () => {
    const h = harness({ sourceSha256: "0".repeat(64) });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("原本 SHA-256");
    expect(h.api.actions()).toEqual([]);
    expect(h.api.calls.filter((call) => call.kind !== "getSpec")).toEqual([]);
  });

  it("版が草案の版と違えば、1つも書かずに止まる", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, schemaVersion: "community.app-spec/v0.1" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("版");
    expect(h.api.actions()).toEqual([]);
  });

  it("前回の失敗の残り（タスク）を片付けてから、メンバーは名前で再利用する", async () => {
    const members = seededMembers();
    const h = harness({
      sourceSha256: SOURCE_SHA,
      seed: { members, tasks: seededTasks(members.map((member) => member.id)) },
    });
    const result = await h.run();

    expect(result.ok, h.out.join("\n")).toBe(true);
    // 残っていたタスクは消し、メンバーは足さない（名前で引いて再利用する）
    expect(countOf(h.api, "addMember")).toBe(0);
    expect(h.api.members()).toHaveLength(3);
    expect(h.api.tasks()).toEqual([]);
    // 最初の片付け（削除）が、メンバーをそろえるより前に来る
    expect(h.api.actions().indexOf("deleteTask")).toBeLessThan(h.api.actions().indexOf("addTask"));
  });
});

describe("runTaskBoard：失敗の経路でも後片付けする", () => {
  it("一覧の照合（ボードのタスクの状態）を失敗させても、片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, breakView: "board" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("状態");
    expect(countOf(h.api, "deleteTask")).toBeGreaterThan(0);
    expect(h.api.tasks()).toEqual([]);
  });

  it("タスクの登録を失敗させても、作ったものを片付ける", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failTask: "しおり作り" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("しおり作り");
    expect(h.api.tasks()).toEqual([]);
  });

  it("finish を失敗させても、片付けて、成功と報告しない", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failFinish: "しおり作り" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("完了にできない");
    expect(h.api.tasks()).toEqual([]);
  });

  it("後片付け（タスクの削除）が失敗したら、成功と報告しない", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, failDelete: "しおり作り" });
    const result = await h.run();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("後片付け");
  });

  it("通信できないときは例外にする（値を含む文言は、呼ぶ側（cli.ts）が捨てる）", async () => {
    const h = harness({ sourceSha256: SOURCE_SHA, unreachable: "fetch failed: https://example/ops" });
    await expect(h.run()).rejects.toThrow();
  });
});
