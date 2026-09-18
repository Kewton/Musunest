// api-measure-fixture（/api の計測の測定条件と判定）の試験（Issue #111）。**実環境には一切届かない。**
//
// 見るのは4つである。
//   1. 経路と規模が、宣言（appspec-schema の api.ts と見本 app.spec.yaml）と一致する
//   2. P-7 の線：6.999 ms・7.000 ms は非抵触、7.001 ms は抵触。**3 Worker の和が 7 ms を超えても P-7 にしない**
//   3. P-1 の線：過去 7 日に 1 件でもあれば抵触。**読めないときは非抵触にせず判断不能**
//   4. 経路の3つ（host・gateway・data-api）が measure-free-tier の WORKERS と一致する
import { describe, expect, it } from "vitest";
import { apiActionPath, apiSpecPath, apiViewPath } from "../../packages/appspec-schema/src/api.ts";
import {
  API_GAP_MS,
  API_MEASURED_REQUESTS,
  API_MEMBER_NAMES,
  API_ROUTES,
  API_SIZES,
  API_WARMUP_REQUESTS,
  API_WORKERS,
  actionPath,
  expensePlans,
  expensesOf,
  judgeP1,
  judgeP7,
  P7_LIMIT_MS,
  P7_LIMIT_US,
  routeById,
  routePath,
  sizeById,
  type Verdicts,
} from "./api-measure-fixture.ts";
import { WORKERS } from "./measure-free-tier.ts";

/** 3 Worker に同じ値を入れる（境界の試験用） */
const all = (us: number): Verdicts => ({ host: us, gateway: us, "data-api": us });

describe("測定条件：経路", () => {
  it("測る経路は4つ（#102 の spec・支出一覧・member の集計一覧・#108 の精算結果）", () => {
    expect(API_ROUTES.map((route) => route.id)).toEqual(["spec", "expenseList", "memberList", "settlement"]);
  });

  it("経路のパスは契約の正本（appspec-schema の api.ts）から組む（写しを作らない）", () => {
    expect(routePath("inst-1", routeById("spec"))).toBe(apiSpecPath("inst-1"));
    expect(routePath("inst-1", routeById("expenseList"))).toBe(apiViewPath("inst-1", "expenseList"));
    expect(routePath("inst-1", routeById("memberList"))).toBe(apiViewPath("inst-1", "memberList"));
    expect(routePath("inst-1", routeById("settlement"))).toBe(apiViewPath("inst-1", "settlement"));
    expect(actionPath("inst-1", "addExpense")).toBe(apiActionPath("inst-1", "addExpense"));
  });

  it("経路の順（host → gateway → data-api）が measure-free-tier の WORKERS と一致する", () => {
    expect(API_WORKERS).toEqual(WORKERS);
  });
});

describe("測定条件：規模とデータ", () => {
  it("規模は3段階（基本＝A/B/C と 2 支出・20 件・200 件）", () => {
    expect(API_SIZES.map((size) => size.id)).toEqual(["basic", "20", "200"]);
    expect(expensesOf(sizeById("basic"))).toBe(2);
    expect(expensesOf(sizeById("20"))).toBe(20);
    expect(expensesOf(sizeById("200"))).toBe(200);
  });

  it("メンバーは規模によらず A・B・C の 3 人", () => {
    expect(API_MEMBER_NAMES).toEqual(["A", "B", "C"]);
  });

  it("基本は見本（夕食 6000 を A が払い 3 人で割る・タクシー 3000 を B が払い 3 人で割る）と同じ", () => {
    expect(expensePlans(sizeById("basic"))).toEqual([
      { description: "夕食", amount: 6000, payerIndex: 0, participantIndexes: [0, 1, 2] },
      { description: "タクシー", amount: 3000, payerIndex: 1, participantIndexes: [0, 1, 2] },
    ]);
  });

  it("増量は**同じ 2 支出の組**を 10 組・100 組にする（組の数だけ件数が増える）", () => {
    const many = expensePlans(sizeById("20"));
    expect(many).toHaveLength(20);
    // 先頭の組は基本と同じ内容（description に組の番号を付けないのは組が 1 つのときだけ）
    expect(many.slice(0, 2).map((plan) => plan.amount)).toEqual([6000, 3000]);
    expect(many[0]?.description).toBe("夕食 1");
    expect(many[1]?.description).toBe("タクシー 1");
    expect(many.filter((plan) => plan.amount === 6000)).toHaveLength(10);
    expect(expensePlans(sizeById("200")).filter((plan) => plan.amount === 3000)).toHaveLength(100);
  });

  it("測り方は 5 回温め → 60 秒空けて → 20 回（Q15 の決定）", () => {
    expect(API_WARMUP_REQUESTS).toBe(5);
    expect(API_MEASURED_REQUESTS).toBe(20);
    expect(API_GAP_MS).toBe(60_000);
  });
});

describe("P-7：落ち着いた状態の Worker 単体の最大が厳密に 7 ms を超えたか", () => {
  it("6.999 ms は非抵触", () => {
    const finding = judgeP7(all(6999));
    expect(finding.verdict).toBe("clear");
    expect(finding.over).toEqual([]);
    expect(finding.maxMs.host).toBeCloseTo(6.999);
  });

  it("7.000 ms は非抵触（厳密に超えたときだけ抵触）", () => {
    const finding = judgeP7({ host: 7000, gateway: 100, "data-api": 100 });
    expect(finding.verdict).toBe("clear");
    expect(P7_LIMIT_US).toBe(7000);
    expect(P7_LIMIT_MS).toBe(7);
  });

  it("7.001 ms は抵触", () => {
    const finding = judgeP7({ host: 7001, gateway: 100, "data-api": 100 });
    expect(finding.verdict).toBe("touched");
    expect(finding.over).toEqual(["host"]);
  });

  it("各 Worker が 7 ms 以下で、和が 7 ms を超えても P-7 にしない（和は記録だけ）", () => {
    const finding = judgeP7({ host: 3000, gateway: 2500, "data-api": 2000 });
    expect(finding.verdict).toBe("clear");
    expect(finding.over).toEqual([]);
    expect(finding.sumMs).toBeCloseTo(7.5);
  });

  it("和が 7 ms を超えても、単体が 7 ms を超えた Worker だけが over に入る", () => {
    const finding = judgeP7({ host: 8000, gateway: 3000, "data-api": 3000 });
    expect(finding.verdict).toBe("touched");
    expect(finding.over).toEqual(["host"]);
    expect(finding.sumMs).toBeCloseTo(14);
  });
});

describe("P-1：過去 7 日の exceededResources が 1 件以上か", () => {
  it("0 件なら非抵触", () => {
    const finding = judgeP1({ musunest: 0, unknown: 0, since: "2026-09-11", until: "2026-09-17" }, undefined);
    expect(finding.verdict).toBe("clear");
    expect(finding.exceeded).toBe(0);
    expect(finding.period).toBe("2026-09-11〜2026-09-17");
  });

  it("1 件でもあれば抵触（名前が __unknown__ の起動も MUSUNEST に数える）", () => {
    expect(judgeP1({ musunest: 1, unknown: 0, since: "s", until: "u" }, undefined).verdict).toBe("touched");
    expect(judgeP1({ musunest: 0, unknown: 2, since: "s", until: "u" }, undefined).verdict).toBe("touched");
  });

  it("過去 7 日分が確認できないときは、非抵触と報告せず判断不能にする", () => {
    const finding = judgeP1(undefined, "Analytics を読む権限が足りない");
    expect(finding.verdict).toBe("undetermined");
    expect(finding.exceeded).toBeUndefined();
    expect(finding.reason).toContain("権限");
    expect(finding.reason).toContain("非抵触と報告しない");
  });
});
