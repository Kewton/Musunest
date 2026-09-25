// e2e/src/ui/run.ts — 画面テストを 1 周流す（Issue #233）。
//
// 流れは「ブラウザを開く → 手順ごとに（データを空にする → 画面で流す → 片付ける）→ レポートを書く」である。
// **ブラウザを開くのは呼ぶ側が決める**（`launch` を差し替えられる）——宛先やインスタンスの検査は
// `cli.ts` がブラウザを開く前に済ませるので、**検査で止まったときは 1 回も開かない**。
//
// 手順は 3 つの見本（warikan・task-board・dashboard）と「残るか」の 4 つで、それぞれ**専用のインスタンス**を
// 使う（`<接頭辞>-<見本>`。デモと e2e のインスタンスには触らない）。**確かめる操作は画面だけ**である。
// データを空にする・片付けるのは API を使ってよい（所有者の決定 2026-09-25）。
//
// ログに URL・ホスト名・資格情報を出さない。応答の生の本文も出さない。例外の文言も出さない（種別だけ）。

import type { Browser, BrowserContext } from "playwright";
import type { AppSpec, MusunestClient } from "@musunest/sdk";
import { describeError, errorKind } from "../warikan.js";
import type { SecretValue } from "./redact.js";
import { writeReport, type ScreenshotFile, type StepResult, type UiReport } from "./report.js";
import { SCENARIOS, shiftDate, todayJst, type Scenario, type ScenarioContext, type Step } from "./scenarios.js";

/** 画面の大きさ（スマホと同じ。`04` §7.2） */
export const VIEWPORT = { width: 360, height: 800 } as const;

export interface RunDeps {
  /** host のオリジン（**ログにもレポートにも出さない**） */
  readonly baseUrl: string;
  /** 画面テスト専用インスタンスの接頭辞（`m15-ui`。見本ごとに `-warikan` などを付ける） */
  readonly instanceId: string;
  /** 型付きクライアント（片付けだけに使う。**確かめる操作は画面で行う**） */
  readonly client: MusunestClient;
  /** ブラウザを開く。既定は `cli.ts` が渡す playwright の chromium。**試験は差し替える** */
  readonly launch: () => Promise<Browser>;
  /** レポートのディレクトリ（`workspace/mvp/m1/ui-report/`。上書きする） */
  readonly reportDir: string;
  /** 伏せる値・混入を探す値 */
  readonly secrets: readonly SecretValue[];
  readonly now: () => Date;
  /** 実行したコミット（引けなければ空） */
  readonly commit: string;
  /** 流す手順。既定は 4 つ。**試験は偽の手順を差し込む** */
  readonly scenarios?: readonly Scenario[];
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface RunResult {
  readonly ok: boolean;
  /** 人が読む理由。**値（URL・ホスト名・資格情報）を含めない** */
  readonly reason: string;
  readonly steps: readonly StepResult[];
}

interface ClearResult {
  readonly ok: boolean;
  readonly reason: string;
}

/** 消す操作を持つ entity と、その行を読む一覧（消す順は気にしない——何周か回して参照の向きを吸収する） */
function deletableViews(spec: AppSpec): readonly { readonly view: string; readonly action: string }[] {
  const found: { view: string; action: string }[] = [];
  for (const entity of spec.entities) {
    const action = spec.actions.find(
      (candidate) => candidate.entity === entity.name && (candidate.kind ?? "create") === "delete",
    );
    if (action === undefined) continue;
    const view = spec.views.find(
      (candidate) =>
        candidate.entity === entity.name &&
        (candidate.type === undefined || candidate.type === "table" || candidate.type === "list" || candidate.type === "board"),
    );
    if (view !== undefined) found.push({ view: view.name, action: action.name });
  }
  return found;
}

/**
 * 専用インスタンスのデータを空にする（片付けは API を使ってよい）。
 *
 * 消す操作を持つ entity を、**参照されている行を先に消さなくても済むよう、何周か回す**
 * （warikan は支出 → メンバー、dashboard は活動 → メンバーの順に消さないと 409 で残る）。
 * 消せない行（409・404）は次の周に回し、**最後に一覧を読んで、残りが 0 件であることを確かめる**。
 * 消す操作を宣言していない entity（task-board の member）は、対象に入れない（画面が名前で再利用する）。
 */
async function clearInstance(client: MusunestClient, instanceId: string): Promise<ClearResult> {
  const spec = await client.getSpec(instanceId);
  if (!spec.ok) return { ok: false, reason: `宣言を読めない（${describeError(spec.error)}）` };
  const targets = deletableViews(spec.value.spec);

  for (let pass = 0; pass <= targets.length; pass++) {
    let deleted = 0;
    for (const target of targets) {
      const listed = await client.getView(instanceId, target.view);
      if (!listed.ok) return { ok: false, reason: `一覧（${target.view}）を読めない（${describeError(listed.error)}）` };
      for (const row of listed.value.rows) {
        const removed = await client.deleteRecord(instanceId, target.action, row.id);
        if (removed.ok) {
          deleted++;
          continue;
        }
        // 参照されている（もう次の周で消える）・既に無い は、次の周に回す。それ以外は止める
        if (removed.error.code !== "REFERENCE_IN_USE" && removed.error.code !== "NOT_FOUND") {
          return { ok: false, reason: `行を消せない（${describeError(removed.error)}）` };
        }
      }
    }
    if (deleted === 0) break;
  }

  for (const target of targets) {
    const listed = await client.getView(instanceId, target.view);
    if (!listed.ok) return { ok: false, reason: `一覧（${target.view}）を読めない（${describeError(listed.error)}）` };
    if (listed.value.rows.length > 0) {
      return { ok: false, reason: `専用データが残っている（${target.view} に ${listed.value.rows.length} 行）` };
    }
  }
  return { ok: true, reason: "" };
}

/** 1 つの手順を流す（前の片付け → 画面 → 後の片付け）。片付けの失敗は `problems` に足す */
async function runScenario(
  deps: RunDeps,
  browser: Browser,
  scenario: Scenario,
  steps: StepResult[],
  screenshots: ScreenshotFile[],
  problems: string[],
): Promise<void> {
  const instanceId = `${deps.instanceId}-${scenario.suffix}`;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const extraContexts: BrowserContext[] = [];
  try {
    const page = await context.newPage();
    const before = await clearInstance(deps.client, instanceId);
    if (!before.ok) {
      steps.push({
        scenario: scenario.name,
        step: "前の片付け（API）",
        ok: false,
        expected: "専用データが空",
        actual: `空にできない（${before.reason}）`,
      });
      return;
    }
    const ctx: ScenarioContext = {
      page,
      url: `${deps.baseUrl}/apps/${instanceId}`,
      instanceId,
      shot: async (label) => {
        const path = `shots/${scenario.suffix}-${label}.png`;
        screenshots.push({ path, data: await page.screenshot({ fullPage: true }) });
        return path;
      },
      openAnotherPage: async () => {
        const other = await browser.newContext({ viewport: VIEWPORT });
        extraContexts.push(other);
        return other.newPage();
      },
      today: () => todayJst(deps.now()),
      shiftToday: (days) => shiftDate(todayJst(deps.now()), days),
    };

    let produced: readonly Step[] = [];
    try {
      produced = await scenario.run(ctx);
    } catch (e) {
      produced = [
        ...produced,
        { step: "手順の実行", ok: false, expected: "最後まで流せる", actual: `予期しない失敗（${errorKind(e)}）` },
      ];
    }
    for (const step of produced) steps.push({ scenario: scenario.name, ...step });
    if (produced.length === 0) problems.push(`${scenario.name}: 項目が 1 つも記録されなかった`);

    const after = await clearInstance(deps.client, instanceId);
    if (!after.ok) problems.push(`${scenario.name}: 片付けに失敗した（${after.reason}）`);
  } finally {
    for (const extra of extraContexts) await extra.close();
    await context.close();
  }
}

/**
 * 4 つの手順を流し、レポートを書き出す。
 * **合否は「すべての項目が合格で、問題が 1 つも無く、レポートを書けた」ことである。**
 */
export async function runUi(deps: RunDeps): Promise<RunResult> {
  const startedAt = deps.now().toISOString();
  const steps: StepResult[] = [];
  const screenshots: ScreenshotFile[] = [];
  const problems: string[] = [];

  let browser: Browser;
  try {
    browser = await deps.launch();
  } catch (e) {
    return { ok: false, reason: `ブラウザを開けない（${errorKind(e)}）`, steps };
  }

  try {
    for (const scenario of deps.scenarios ?? SCENARIOS) {
      await runScenario(deps, browser, scenario, steps, screenshots, problems);
      deps.out(`e2e-ui: ${scenario.name} を流した（${steps.filter((step) => step.scenario === scenario.name).length} 項目）`);
    }
  } finally {
    await browser.close();
  }

  const finishedAt = deps.now().toISOString();
  const ok = steps.length > 0 && steps.every((step) => step.ok) && problems.length === 0;
  const report: UiReport = { ok, startedAt, finishedAt, commit: deps.commit, steps, notes: [], problems };

  try {
    await writeReport({ dir: deps.reportDir, report, secrets: deps.secrets, screenshots });
  } catch (e) {
    return { ok: false, reason: `レポートを書けない（${errorKind(e)}）`, steps };
  }

  if (ok) return { ok: true, reason: "", steps };
  const failed = steps.filter((step) => !step.ok).length;
  return {
    ok: false,
    reason: problems.length > 0 ? problems.join(" / ") : `合格でない項目が ${failed} 件ある`,
    steps,
  };
}
