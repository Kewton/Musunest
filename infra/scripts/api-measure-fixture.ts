// api-measure-fixture — `/api` の経路の CPU 時間を staging で測るための**測定条件と判定の正本**（Issue #111）。
//
// この file が持つのは次の3つだけである。送る・待つ・読むは measure-free-tier.ts の `--api` モードが行う
// （時計・sleep・HTTP・Analytics を差し替えられる形にしてあり、unit は fake でこの条件と順を確かめる）。
//
//   1. **どの経路を測るか** … #102 の spec・支出一覧・member の集計一覧・#108 の精算結果（`API_ROUTES`）
//   2. **どの規模か** … 基本（A/B/C と 2 支出）・20 件・200 件（`API_SIZES`。同じ 2 支出の組を 1・10・100 組）
//   3. **P-7 / P-1 の判定** … 数字の線（`judgeP7`・`judgeP1`）
//
// ── 出典 ──────────────────────────────────────────────────────────────────────
//   正本：workspace/mvp/m0/06-plan-and-limits.md §5（P-7・P-1 の宣言）・§7・§8（M0 の再測の測り方）
//        workspace/mvp/m1/00-open-questions.md Q15（2026-09-16 所有者の決定：5 回温め → 60 秒 → 20 回）
//   見本：packages/appspec-schema/samples/warikan（app.spec.yaml・scenario.json。A/B/C と夕食 6000・タクシー 3000）
//
// ── P-7 の判定（ここを外さないこと）────────────────────────────────────────────
// **落ち着いた状態の Worker 単体の最大が、厳密に 7 ms を超えた**ときに抵触する。
// 6.999 ms と 7.000 ms は非抵触、7.001 ms は抵触である。**比較はマイクロ秒の整数で行う**
// （`max.cpuTime` の単位がマイクロ秒なので、7 ms = 7000 µs を「超える」で判定すれば丸めの誤りが入らない）。
// **3 Worker の最大の和は記録するだけで、判定には使わない**（06 §7 #1 が未確定のため。Q15 の決定）。
//
// ── P-1 の判定 ────────────────────────────────────────────────────────────────
// 過去 7 日の `exceededResources`（status が exceeded* の起動）が **1 件以上**なら抵触する。
// **20 回の窓で 0 件という理由だけで非抵触にしない**——既存の期間レポート `free-tier-report.ts` を別に読む
// （読むのは measure-free-tier.ts 側）。**過去 7 日分が確認できなければ非抵触ではなく判断不能**にする。
//
// ── 安全面（CLAUDE.md「このリポジトリは public である」）────────────────────────
// この file は値を持たない（回数・ミリ秒・名前だけ）。URL・バケット名・Account ID・資格情報を組み立てない。

import { apiActionPath, apiSpecPath, apiViewPath } from "../../packages/appspec-schema/src/api.ts";
// **実行時の循環を作らないため、ここから measure-free-tier.ts を読まない**（向きは measure-free-tier → この file の一方向）。
// Worker の名前は、measure-free-tier の WORKERS と一致することを api-measure-fixture.test.ts が確かめる。

/** 測る環境。production は別アカウントで `/api/*` が 404 なので測らない（README §7.3・Q5）。 */
export const API_TARGET_ENV = "staging" as const;

// ── 測り方（Q15 の決定。measure-free-tier.ts の既定もこれを読む）──────────────────

/** 1 経路・1 規模ごとに、本測定の前に送る回数 */
export const API_WARMUP_REQUESTS = 5;
/** 1 経路・1 規模ごとに測る回数 */
export const API_MEASURED_REQUESTS = 20;
/** 温めと本測定の間。**窓を分ける**ために空ける */
export const API_GAP_MS = 60_000;
/** 3 Worker（host → gateway → data-api。03 §1）。Analytics は Worker ごとに記録される */
export const API_WORKERS = ["host", "gateway", "data-api"] as const;
export type ApiWorker = (typeof API_WORKERS)[number];

// ── 経路 ──────────────────────────────────────────────────────────────────────

export type ApiRouteId = "spec" | "expenseList" | "memberList" | "settlement";

export interface ApiRoute {
  readonly id: ApiRouteId;
  readonly label: string;
  /** 一覧の名前。spec の経路は持たない（パスが違う） */
  readonly viewName?: string;
}

/** 測る経路（Issue #111 の `## やること`）。宣言の名前は見本 app.spec.yaml の写し */
export const API_ROUTES: readonly ApiRoute[] = [
  { id: "spec", label: "宣言の読み込み（#102）" },
  { id: "expenseList", label: "支出一覧", viewName: "expenseList" },
  { id: "memberList", label: "member の集計一覧", viewName: "memberList" },
  { id: "settlement", label: "精算の結果（#108）", viewName: "settlement" },
];

/** 経路のパス。**契約の正本（appspec-schema の api.ts）から組む**——ここで書き直さない */
export const routePath = (instanceId: string, route: ApiRoute): string =>
  route.viewName === undefined ? apiSpecPath(instanceId) : apiViewPath(instanceId, route.viewName);

/** 操作のパス。準備と片付け（計測の窓の外）に使う */
export const actionPath = (instanceId: string, actionName: string): string => apiActionPath(instanceId, actionName);

export const routeById = (id: ApiRouteId): ApiRoute => {
  const route = API_ROUTES.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`知らない経路: ${id}`);
  return route;
};

// ── 規模とデータ ──────────────────────────────────────────────────────────────

export type ApiSizeId = "basic" | "20" | "200";

export interface ApiSize {
  readonly id: ApiSizeId;
  readonly label: string;
  /** 同じ 2 支出の組の数。1・10・100 */
  readonly groups: number;
}

/** 規模は3段階（Issue #111 の `## やること`）。**同じ 2 支出の組を 1・10・100 組**にする */
export const API_SIZES: readonly ApiSize[] = [
  { id: "basic", label: "基本（A/B/C と 2 支出）", groups: 1 },
  { id: "20", label: "20 件（2 支出 × 10 組）", groups: 10 },
  { id: "200", label: "200 件（2 支出 × 100 組）", groups: 100 },
];

export const sizeById = (id: ApiSizeId): ApiSize => {
  const size = API_SIZES.find((candidate) => candidate.id === id);
  if (size === undefined) throw new Error(`知らない規模: ${id}`);
  return size;
};

/** メンバー（見本 scenario.json と同じ A・B・C。**規模によらず 3 人**） */
export const API_MEMBER_NAMES = ["A", "B", "C"] as const;

/** 1 規模の支出の件数（= 2 × 組の数） */
export const expensesOf = (size: ApiSize): number => size.groups * 2;

/** 1 件の支出の入力。payer と participants は `API_MEMBER_NAMES` の添字で持つ */
export interface ExpensePlan {
  readonly description: string;
  readonly amount: number;
  readonly payerIndex: number;
  readonly participantIndexes: readonly number[];
}

/** 増やす元になる 2 支出（見本 scenario.json の夕食 6000・タクシー 3000 と同じ） */
export const BASE_EXPENSES: readonly ExpensePlan[] = [
  { description: "夕食", amount: 6000, payerIndex: 0, participantIndexes: [0, 1, 2] },
  { description: "タクシー", amount: 3000, payerIndex: 1, participantIndexes: [0, 1, 2] },
];

/**
 * 規模の支出の並び。**同じ 2 支出の組を `groups` 回**にする。
 * 組が 1 つのとき（基本）は見本とまったく同じ内容にする（description に組の番号を付けない）。
 */
export function expensePlans(size: ApiSize): readonly ExpensePlan[] {
  const plans: ExpensePlan[] = [];
  for (let group = 1; group <= size.groups; group++) {
    for (const base of BASE_EXPENSES) {
      plans.push({
        ...base,
        description: size.groups === 1 ? base.description : `${base.description} ${group}`,
      });
    }
  }
  return plans;
}

// ── P-7 の判定 ────────────────────────────────────────────────────────────────

/** P-7 の線（ms）。**厳密に超えたら抵触**（6.999・7.000 は非抵触、7.001 は抵触） */
export const P7_LIMIT_MS = 7;
/** 同じ線をマイクロ秒で持つ（判定はこちらで行う。丸めの誤りを入れない） */
export const P7_LIMIT_US = P7_LIMIT_MS * 1000;

/** 3 つの値。**記録するだけで判定には使わない**（06 §7 #1 が未確定のため） */
export interface Verdicts {
  readonly host: number;
  readonly gateway: number;
  readonly "data-api": number;
}

export type Verdict = "touched" | "clear" | "undetermined";

export interface P7Finding {
  readonly verdict: Verdict;
  /** 厳密に 7 ms を超えた Worker（判定に使う） */
  readonly over: readonly ApiWorker[];
  /** Worker ごとの最大（µs）。入力のまま */
  readonly maxUs: Verdicts;
  /** Worker ごとの最大（ms）。記録用 */
  readonly maxMs: Verdicts;
  /** 3 Worker の最大の和（ms）。**記録するだけ。7 ms を超えても P-7 にしない** */
  readonly sumMs: number;
  readonly reason: string;
}

const toMs = (us: number): number => us / 1000;
export const fmtMs = (value: number): string => `${value.toFixed(3)} ms`;

const maxList = (ms: Verdicts): string => API_WORKERS.map((worker) => `${worker} ${fmtMs(ms[worker])}`).join("・");

/**
 * P-7 を判定する。入力は Worker ごとの「窓の中の max.cpuTime」の**マイクロ秒**。
 * 3 つとも揃っていることを前提にする（欠け・名前不明・回数の不一致は、呼ぶ側が先に判断不能にする）。
 */
export function judgeP7(maxUs: Verdicts): P7Finding {
  const over = API_WORKERS.filter((worker) => maxUs[worker] > P7_LIMIT_US);
  const maxMs: Verdicts = {
    host: toMs(maxUs.host),
    gateway: toMs(maxUs.gateway),
    "data-api": toMs(maxUs["data-api"]),
  };
  const sumMs = API_WORKERS.reduce((total, worker) => total + maxMs[worker], 0);
  return {
    verdict: over.length > 0 ? "touched" : "clear",
    over,
    maxUs,
    maxMs,
    sumMs,
    reason:
      over.length > 0
        ? `${over.join("・")} が単体で ${P7_LIMIT_MS} ms を超えた（${maxList(maxMs)}）。P-7 に触れた`
        : `どの Worker も単体で ${P7_LIMIT_MS} ms を超えていない（${maxList(maxMs)}）`,
  };
}

// ── P-1 の判定 ────────────────────────────────────────────────────────────────

/** 期間レポート（free-tier-report.ts）から読んだ、過去 7 日の上限超過の件数 */
export interface ExceededReading {
  /** MUSUNEST の Worker の起動のうち、status が exceeded* だった回数 */
  readonly musunest: number;
  /** 名前が __unknown__ の起動のうち、status が exceeded* だった回数（MUSUNEST かもしれないので数える） */
  readonly unknown: number;
  readonly since: string;
  readonly until: string;
}

export interface P1Finding {
  readonly verdict: Verdict;
  /** 読めたときだけ。**読めなかったら undefined（0 にしない）** */
  readonly exceeded: number | undefined;
  /** 読めたときだけ `since〜until` */
  readonly period: string | undefined;
  readonly reason: string;
}

/**
 * P-1 を判定する。`reading` が undefined なら（＝過去 7 日分が確認できない）、
 * **非抵触と報告せず判断不能**にする（`failure` に読めなかった理由を渡す）。
 */
export function judgeP1(reading: ExceededReading | undefined, failure: string | undefined): P1Finding {
  if (reading === undefined) {
    return {
      verdict: "undetermined",
      exceeded: undefined,
      period: undefined,
      reason: `過去 7 日の上限超過（exceededResources）を確認できない（${failure ?? "理由不明"}）。非抵触と報告しない`,
    };
  }
  const exceeded = reading.musunest + reading.unknown;
  const period = `${reading.since}〜${reading.until}`;
  return {
    verdict: exceeded >= 1 ? "touched" : "clear",
    exceeded,
    period,
    reason:
      exceeded >= 1
        ? `過去 7 日（${period}）に上限超過が ${exceeded} 件（MUSUNEST ${reading.musunest}・名前なし ${reading.unknown}）。P-1 に触れた`
        : `過去 7 日（${period}）の上限超過は 0 件（MUSUNEST ${reading.musunest}・名前なし ${reading.unknown}）`,
  };
}

