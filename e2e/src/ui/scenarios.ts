// e2e/src/ui/scenarios.ts — 画面テストの 4 つの手順（Issue #233）。
//
// 窓口が作った手順（M1.5。割り勘・タスク管理・ダッシュボード・残るか）を、**Playwright のライブラリ**で
// ブラウザの画面から流す。**確かめる操作は画面だけ**である（データを空にする・片付けるのは API を使ってよい。
// それは `run.ts` が行う）。種を API で入れて画面で確かめる、という迂回はしない——M1.4 のデモで
// 「API では動くのに画面から入力できない」欠陥が見えなかったことへの手当てである（`docs/parallel-development.md` §7.4）。
//
// 画面の幅はスマホと同じ **360 CSS px** にして、**横にはみ出していないことも見る**（`04` §7.2）。
// 写真は各項目に 1 枚添える（`ctx.shot`）。**写真の道は `shots/…png` の相対だけである**——URL は 1 つも持たない。
//
// 見ている画面の目印（`apps/host/src/app/*.tsx` が正本）:
//   main.instant-renderer[data-state=ready]  描けた
//   nav.views button                         一覧の切替（ボタンの文字が view の名前）
//   section.add form.add-form                追加のフォーム（`#field-<項目名>`・`button.submit`）
//   section.edit-form form.add-form          「直す」のフォーム（同じ部品。追加と同時に出るので**必ず親で絞る**）
//   table.instant-table / li.list-row        一覧の行
//   article.board-card[data-highlighted]     ボードのカード（強調は色と `▲` の印の両方）
//   .delete / button.edit / button.run-action 行ごとのボタン
//   [data-part=<計算の名前>] dd               ダッシュボードの数値の部品
//   tr.chart-entry[data-heading=<見出し>] td  棒・円の表の 1 行

import type { Locator, Page } from "playwright";

/** 画面の 1 項目の結果。`report.ts` の `StepResult` から `scenario` を外した形である */
export interface Step {
  readonly step: string;
  readonly ok: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly screenshot?: string;
}

/** 手順に渡すもの。**宛先の URL はここにしか無い**（手順は環境変数を読まない） */
export interface ScenarioContext {
  readonly page: Page;
  /** そのインスタンスの画面（`<origin>/apps/<instanceId>`）。**値はログにもレポートにも出さない** */
  readonly url: string;
  readonly instanceId: string;
  /** 画面の写真を 1 枚取り、レポートからの相対の道を返す */
  readonly shot: (label: string) => Promise<string>;
  /** 別の端末の代わりに、別のブラウザのコンテキストで開く（「残るか」で使う） */
  readonly openAnotherPage: () => Promise<Page>;
  /** 今日（日本時間）の `YYYY-MM-DD` */
  readonly today: () => string;
  /** 今日から日をずらした `YYYY-MM-DD` */
  readonly shiftToday: (days: number) => string;
}

export interface Scenario {
  /** 報告に出す名前 */
  readonly name: string;
  /** インスタンスの接頭辞に付ける見本の名前（`m15-ui` → `m15-ui-warikan`） */
  readonly suffix: string;
  readonly run: (ctx: ScenarioContext) => Promise<readonly Step[]>;
}

/** 画面の幅（スマホと同じ。`04` §7.2） */
export const MOBILE_WIDTH = 360;

const READY = "main.instant-renderer[data-state=ready]";

/**
 * 今日（日本時間）の `YYYY-MM-DD`。**時計を差し替えられる**ように `now` を受け取る
 * （期限の「今日より前・後」を作るのに使う。data-api は日本時間で解く）。
 */
export function todayJst(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` を日数だけずらす */
export function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 見えている文字（無ければ「（出ていない）」）。**期待と実際を並べて比べる**ために使う */
async function shown(locator: Locator): Promise<string> {
  if ((await locator.count()) === 0) return "（出ていない）";
  return normalize(await locator.first().innerText());
}

/** 並んでいる行の文字を、行の順に（無ければ「（出ていない）」） */
async function shownAll(locator: Locator): Promise<string> {
  const count = await locator.count();
  if (count === 0) return "（出ていない）";
  const texts: string[] = [];
  for (let index = 0; index < count; index++) texts.push(normalize(await locator.nth(index).innerText()));
  return texts.join(" / ");
}

/** 1 項目を記録する（写真を 1 枚添える） */
async function check(
  ctx: ScenarioContext,
  label: string,
  step: string,
  expected: string,
  actual: string,
  ok: boolean,
): Promise<Step> {
  const screenshot = await ctx.shot(label);
  return { step, ok, expected, actual, screenshot };
}

/** ページの横の幅（`scrollWidth`）。**DOM の型を持ち込まない**ので、式を文字列で渡す */
const scrollWidthOf = (page: Page): Promise<number> =>
  page.evaluate<number>("document.documentElement.scrollWidth");

/** 横にはみ出していないかを見る 1 項目。**各手順の、中身が出そろったところで呼ぶ** */
async function widthStep(ctx: ScenarioContext, label: string, step: string): Promise<Step> {
  const width = await scrollWidthOf(ctx.page);
  return check(
    ctx,
    label,
    step,
    `横にはみ出さない（scrollWidth ≤ ${MOBILE_WIDTH}）`,
    `scrollWidth=${width}`,
    width <= MOBILE_WIDTH,
  );
}

/** アプリを開いて、描けるまで待つ */
async function open(ctx: ScenarioContext, page: Page = ctx.page): Promise<void> {
  await page.goto(ctx.url);
  await page.locator(READY).waitFor();
}

/** 一覧の切替（ボタンの文字が view の名前） */
const switchView = async (page: Page, view: string): Promise<void> => {
  await page.locator("nav.views button", { hasText: view }).first().click();
  await page.locator('nav.views button[aria-pressed="true"]', { hasText: view }).first().waitFor();
  await page.locator(`${READY}`).waitFor();
};

// ── フォーム（追加・直す）の操作。**必ず親（section.add / section.edit-form）で絞る** ──────

const ADD = "section.add";
const EDIT = "section.edit-form";

const fillText = async (page: Page, scope: string, field: string, value: string): Promise<void> => {
  await page.locator(`${scope} #field-${field}`).fill(value);
};

const selectByLabel = async (page: Page, scope: string, field: string, label: string): Promise<void> => {
  await page.locator(`${scope} #field-${field}`).selectOption({ label });
};

const checkChoice = async (page: Page, scope: string, field: string, label: string): Promise<void> => {
  await page
    .locator(`${scope} .field[data-field=${field}] label.choice`, { hasText: label })
    .locator("input[type=checkbox]")
    .check();
};

const submit = async (page: Page, scope: string): Promise<void> => {
  await page.locator(`${scope} button.submit`).click();
};

/** 表の 1 行を、文字で引く */
const tableRow = (page: Page, text: string): Locator =>
  page.locator("table.instant-table tbody tr", { hasText: text }).first();

/** ボードのカードを、文字で引く */
const card = (page: Page, text: string): Locator =>
  page.locator("article.board-card", { hasText: text }).first();

/** カードの項目の値（`data-field` の `dd`） */
const cardField = (page: Page, title: string, field: string): Locator =>
  card(page, title).locator(`[data-field=${field}] dd`);

/** カードの項目が、その表示名になるまで待つ（画面は操作のあとに読み直す） */
const waitCardField = async (page: Page, title: string, field: string, label: string): Promise<void> => {
  await cardField(page, title, field).filter({ hasText: label }).first().waitFor();
};

/** メンバーを、名前がまだ無ければ画面から登録する（画面だけ。残っていれば再利用する） */
async function ensureMember(page: Page, view: string, name: string): Promise<void> {
  await switchView(page, view);
  if ((await tableRow(page, name).count()) > 0 || (await page.locator("li.list-row", { hasText: name }).count()) > 0) {
    return;
  }
  await fillText(page, ADD, "name", name);
  await submit(page, ADD);
  await rowAppears(page, name);
}

/** 行（表でも一覧でも）が出るまで待つ */
async function rowAppears(page: Page, text: string): Promise<void> {
  await page.locator("table.instant-table tbody tr, li.list-row", { hasText: text }).first().waitFor();
}

// ── 1. 割り勘（見本 warikan。M1.2） ─────────────────────────────────────

const WARIKAN_MEMBERS = ["A", "B", "C"] as const;

/** 支出を 1 件、画面から入れる */
async function addExpense(
  page: Page,
  description: string,
  amount: string,
  payer: string,
  participants: readonly string[],
): Promise<void> {
  await fillText(page, ADD, "description", description);
  await fillText(page, ADD, "amount", amount);
  await selectByLabel(page, ADD, "payer", payer);
  for (const participant of participants) await checkChoice(page, ADD, "participants", participant);
  await submit(page, ADD);
  await tableRow(page, description).waitFor();
}

/** 支出の「1 人あたり」（`expenseList` の 2 列目） */
const shareAmountOf = (page: Page, description: string): Promise<string> =>
  shown(tableRow(page, description).locator("td").nth(1));

/** 精算の 1 件ずつの文（`C さん → A さん 3,000 円`） */
const settlementText = (page: Page): Promise<string> =>
  shownAll(page.locator("ul.settlement li.settlement-transfer"));

/** 精算の件数 */
const settlementCount = (page: Page): Promise<number> =>
  page.locator("ul.settlement li.settlement-transfer").count();

const warikan: Scenario = {
  name: "割り勘",
  suffix: "warikan",
  run: async (ctx) => {
    const page = ctx.page;
    const steps: Step[] = [];
    await open(ctx);
    await switchView(page, "memberList");

    // メンバー A・B・C を画面から登録する
    for (const name of WARIKAN_MEMBERS) {
      await fillText(page, ADD, "name", name);
      await submit(page, ADD);
      await tableRow(page, name).waitFor();
    }
    steps.push(
      await check(
        ctx,
        "warikan-members",
        "メンバー A・B・C を画面から登録",
        "memberList に A・B・C の 3 行",
        await shownAll(page.locator("table.instant-table tbody tr")),
        (await page.locator("table.instant-table tbody tr").count()) === 3,
      ),
    );

    // 夕食 6000（A が払い A・B・C）・タクシー 3000（B が払い A・B・C）
    await switchView(page, "expenseList");
    await addExpense(page, "夕食", "6000", "A", WARIKAN_MEMBERS);
    await addExpense(page, "タクシー", "3000", "B", WARIKAN_MEMBERS);
    steps.push(
      await check(
        ctx,
        "warikan-expenses",
        "夕食 6000（A が払い A・B・C）・タクシー 3000（B が払い A・B・C）を登録",
        "1 人あたり 夕食 2000・タクシー 1000",
        `夕食 ${await shareAmountOf(page, "夕食")} / タクシー ${await shareAmountOf(page, "タクシー")}`,
        (await shareAmountOf(page, "夕食")) === "2000" && (await shareAmountOf(page, "タクシー")) === "1000",
      ),
    );

    // 精算が「C → A 3,000」の 1 件だけ
    await switchView(page, "settlement");
    steps.push(
      await check(
        ctx,
        "warikan-settlement",
        "精算が「C → A 3,000」の 1 件だけ",
        "C さん → A さん 3,000 円（1 件）",
        await settlementText(page),
        (await settlementCount(page)) === 1 && (await shown(page.locator("ul.settlement li"))).includes("C さん → A さん 3,000 円"),
      ),
    );
    steps.push(await widthStep(ctx, "warikan-width", "幅 360 CSS px で横にはみ出さない"));

    // タクシーを 6000 に直すと、精算は C → A 2,000 と C → B 2,000
    await switchView(page, "expenseList");
    await tableRow(page, "タクシー").locator("button.edit").first().click();
    await page.locator(EDIT).waitFor();
    await fillText(page, EDIT, "amount", "6000");
    await submit(page, EDIT);
    await page.locator(EDIT).waitFor({ state: "detached" });
    await switchView(page, "settlement");
    const raised = await settlementText(page);
    steps.push(
      await check(
        ctx,
        "warikan-edit-raise",
        "タクシーを 6000 に直す",
        "C さん → A さん 2,000 円と C さん → B さん 2,000 円（2 件）",
        raised,
        (await settlementCount(page)) === 2 && raised.includes("C さん → A さん 2,000 円") && raised.includes("C さん → B さん 2,000 円"),
      ),
    );

    // 3000 に戻すと元に戻る
    await switchView(page, "expenseList");
    await tableRow(page, "タクシー").locator("button.edit").first().click();
    await page.locator(EDIT).waitFor();
    await fillText(page, EDIT, "amount", "3000");
    await submit(page, EDIT);
    await page.locator(EDIT).waitFor({ state: "detached" });
    await switchView(page, "settlement");
    steps.push(
      await check(
        ctx,
        "warikan-edit-restore",
        "3000 に戻すと元に戻る",
        "C さん → A さん 3,000 円（1 件）",
        await settlementText(page),
        (await settlementCount(page)) === 1,
      ),
    );

    // 100 円の支出を足して消す
    await switchView(page, "expenseList");
    await addExpense(page, "お茶", "100", "A", WARIKAN_MEMBERS);
    const afterAdd = await page.locator("table.instant-table tbody tr").count();
    await tableRow(page, "お茶").locator("button.delete").first().click();
    await tableRow(page, "お茶").waitFor({ state: "detached" });
    const afterDelete = await page.locator("table.instant-table tbody tr").count();
    steps.push(
      await check(
        ctx,
        "warikan-add-delete",
        "100 円の支出を足して消す",
        "足すと 3 行、消すと 2 行",
        `足したあと ${afterAdd} 行 / 消したあと ${afterDelete} 行`,
        afterAdd === 3 && afterDelete === 2,
      ),
    );

    // 金額 0 は保存されない（「金額は 1 円以上にしてください」）
    await fillText(page, ADD, "description", "無料");
    await fillText(page, ADD, "amount", "0");
    await selectByLabel(page, ADD, "payer", "A");
    await checkChoice(page, ADD, "participants", "A");
    await submit(page, ADD);
    await page.locator(`${ADD} .failure-validations li`).first().waitFor();
    const message = await shown(page.locator(`${ADD} .failure-validations li`));
    steps.push(
      await check(
        ctx,
        "warikan-zero",
        "金額 0 は保存されない",
        "「金額は 1 円以上にしてください」と出て、行が増えない",
        `${message}（行 ${await page.locator("table.instant-table tbody tr").count()}）`,
        message.includes("金額は 1 円以上にしてください") &&
          (await page.locator("table.instant-table tbody tr").count()) === 2,
      ),
    );

    return steps;
  },
};

// ── 2. タスク管理（見本 task-board。M1.3） ──────────────────────────────

const TASK_BOARD_MEMBERS = ["A", "B"] as const;

async function addTask(page: Page, title: string, assignee: string, due: string): Promise<void> {
  await fillText(page, ADD, "title", title);
  await selectByLabel(page, ADD, "status", "未着手");
  await selectByLabel(page, ADD, "assignee", assignee);
  await fillText(page, ADD, "due", due);
  await submit(page, ADD);
  await card(page, title).waitFor();
}

const taskBoard: Scenario = {
  name: "タスク管理",
  suffix: "task-board",
  run: async (ctx) => {
    const page = ctx.page;
    const steps: Step[] = [];
    await open(ctx);

    // メンバー A・B（残っていれば再利用する。見本は member の削除を宣言していない）
    for (const name of TASK_BOARD_MEMBERS) await ensureMember(page, "members", name);
    const memberRows = await page.locator("table.instant-table tbody tr").count();
    steps.push(
      await check(
        ctx,
        "task-members",
        "メンバー A・B を画面から登録",
        "members に A・B がある（2 行以上）",
        `members ${memberRows} 行`,
        memberRows >= 2,
      ),
    );

    // しおり作り（B・期限は今日より前）・宿の予約（A・期限は今日より後）
    await switchView(page, "board");
    await addTask(page, "しおり作り", "B", ctx.shiftToday(-1));
    await addTask(page, "宿の予約", "A", ctx.shiftToday(1));
    steps.push(
      await check(
        ctx,
        "task-created",
        "しおり作り（B・期限は今日より前）・宿の予約（A・期限は今日より後）を登録",
        "ボードに 2 枚のカード",
        await shownAll(page.locator("article.board-card")),
        (await page.locator("article.board-card").count()) === 2,
      ),
    );
    steps.push(await widthStep(ctx, "task-width", "幅 360 CSS px で横にはみ出さない"));

    // しおり作りが期限切れとして強調される
    const mark = await shown(card(page, "しおり作り").locator(".highlight-mark"));
    steps.push(
      await check(
        ctx,
        "task-overdue",
        "しおり作りが期限切れとして強調される",
        "強調の印「▲ 期限切れ」が出る",
        `data-highlighted=${await card(page, "しおり作り").getAttribute("data-highlighted")} / ${mark}`,
        (await card(page, "しおり作り").getAttribute("data-highlighted")) === "true" && mark.includes("期限切れ"),
      ),
    );

    // 宿の予約で「始める」→ 進行中、「完了にする」→ 完了。完了には「完了にする」が出ない
    await card(page, "宿の予約").locator("button.run-action[data-action=start]").click();
    await waitCardField(page, "宿の予約", "status", "進行中");
    await card(page, "宿の予約").locator("button.run-action[data-action=finish]").click();
    await waitCardField(page, "宿の予約", "status", "完了");
    const finishButtons = await card(page, "宿の予約").locator("button.run-action[data-action=finish]").count();
    steps.push(
      await check(
        ctx,
        "task-finish",
        "宿の予約で「始める」→ 進行中、「完了にする」→ 完了。完了には「完了にする」が出ない",
        "status が 完了。finish のボタンは 0 個",
        `${await shown(cardField(page, "宿の予約", "status"))} / ボタン ${finishButtons} 個`,
        (await shown(cardField(page, "宿の予約", "status"))) === "完了" && finishButtons === 0,
      ),
    );

    // しおり作りの期限を今日より後に直すと、強調が消える
    await card(page, "しおり作り").locator("button.edit").first().click();
    await page.locator(EDIT).waitFor();
    await fillText(page, EDIT, "due", ctx.shiftToday(1));
    await submit(page, EDIT);
    await page.locator(EDIT).waitFor({ state: "detached" });
    await page.locator('article.board-card[data-highlighted="false"]', { hasText: "しおり作り" }).first().waitFor();
    steps.push(
      await check(
        ctx,
        "task-fix-due",
        "しおり作りの期限を今日より後に直す",
        "強調が消える（data-highlighted=false、印が 0 個）",
        `data-highlighted=${await card(page, "しおり作り").getAttribute("data-highlighted")} / 印 ${
          await card(page, "しおり作り").locator(".highlight-mark").count()
        } 個`,
        (await card(page, "しおり作り").getAttribute("data-highlighted")) === "false" &&
          (await card(page, "しおり作り").locator(".highlight-mark").count()) === 0,
      ),
    );

    // 1 件を消す
    await card(page, "しおり作り").locator("button.delete").first().click();
    await card(page, "しおり作り").waitFor({ state: "detached" });
    steps.push(
      await check(
        ctx,
        "task-delete",
        "1 件を消す",
        "しおり作りのカードが消える",
        await shownAll(page.locator("article.board-card")),
        (await card(page, "しおり作り").count()) === 0,
      ),
    );

    return steps;
  },
};

// ── 3. ダッシュボード（見本 dashboard。M1.4） ──────────────────────────

const dashboard: Scenario = {
  name: "ダッシュボード",
  suffix: "dashboard",
  run: async (ctx) => {
    const page = ctx.page;
    const steps: Step[] = [];
    await open(ctx);

    // 最初は今月の活動 0
    const zero = await shown(page.locator("[data-part=activityCount] dd"));
    steps.push(
      await check(
        ctx,
        "dashboard-zero",
        "活動が無いとき「今月の活動」は 0",
        "0 回",
        zero,
        zero === "0 回",
      ),
    );

    // メンバーを 1 人登録し、今日の日付の活動を 1 件入れる
    await ensureMember(page, "members", "A");
    await switchView(page, "activities");
    await fillText(page, ADD, "cost", "1000");
    await selectByLabel(page, ADD, "kind", "練習");
    await fillText(page, ADD, "date", ctx.today());
    await checkChoice(page, ADD, "attendees", "A");
    await submit(page, ADD);
    await rowAppears(page, "練習");
    steps.push(
      await check(
        ctx,
        "dashboard-activity",
        "今日の日付の活動を 1 件、画面から入れる",
        "activities に 1 行",
        `${await shown(page.locator("li.list-row").first())}`,
        (await page.locator("li.list-row").count()) === 1,
      ),
    );

    // 「今月の活動」が 1
    await switchView(page, "dashboard");
    const one = await shown(page.locator("[data-part=activityCount] dd"));
    steps.push(
      await check(
        ctx,
        "dashboard-count",
        "「今月の活動」が 0 → 1",
        "1 回",
        one,
        one === "1 回",
      ),
    );

    // 月ごとの棒の、今月の値が 1
    const month = ctx.today().slice(0, 7);
    const bar = await shown(page.locator(`section[data-chart=activitiesByMonth] tr.chart-entry[data-heading="${month}"] td`));
    steps.push(
      await check(
        ctx,
        "dashboard-bar",
        "月ごとの棒の今月が 1",
        `${month} が 1 回`,
        `${month} が ${bar}`,
        bar === "1 回",
      ),
    );
    steps.push(await widthStep(ctx, "dashboard-width", "幅 360 CSS px で横にはみ出さない"));

    // その活動を消すと 0 に戻る
    await switchView(page, "activities");
    const row = page.locator("li.list-row", { hasText: "練習" }).first();
    await row.locator("button.delete").first().click();
    await row.waitFor({ state: "detached" });
    await switchView(page, "dashboard");
    const back = await shown(page.locator("[data-part=activityCount] dd"));
    steps.push(
      await check(
        ctx,
        "dashboard-delete",
        "その活動を消すと「今月の活動」は 0 に戻る",
        "0 回",
        back,
        back === "0 回",
      ),
    );

    return steps;
  },
};

// ── 4. 残るか（warikan のインスタンス。M1.1 の確認 5 と同じ） ─────────────

const persistence: Scenario = {
  name: "残るか",
  suffix: "warikan",
  run: async (ctx) => {
    const page = ctx.page;
    const steps: Step[] = [];
    await open(ctx);
    await switchView(page, "memberList");

    // 画面から 1 件入れる
    await fillText(page, ADD, "name", "残るか");
    await submit(page, ADD);
    await tableRow(page, "残るか").waitFor();
    steps.push(
      await check(
        ctx,
        "persist-add",
        "メンバーを 1 件、画面から登録",
        "memberList に「残るか」がある",
        await shownAll(page.locator("table.instant-table tbody tr")),
        (await tableRow(page, "残るか").count()) === 1,
      ),
    );

    // 再読み込みしても残る
    await page.reload();
    await page.locator(READY).waitFor();
    await tableRow(page, "残るか").waitFor();
    steps.push(
      await check(
        ctx,
        "persist-reload",
        "再読み込みしても値が残る",
        "「残るか」がある",
        await shownAll(page.locator("table.instant-table tbody tr")),
        (await tableRow(page, "残るか").count()) === 1,
      ),
    );

    // 別のブラウザのコンテキスト（別の端末の代わり）でも同じ値が出る
    const other = await ctx.openAnotherPage();
    await open(ctx, other);
    await switchView(other, "memberList");
    await tableRow(other, "残るか").waitFor();
    steps.push(
      await check(
        ctx,
        "persist-other",
        "別のブラウザのコンテキストで開いても同じ値が出る",
        "「残るか」がある",
        await shownAll(other.locator("table.instant-table tbody tr")),
        (await tableRow(other, "残るか").count()) === 1,
      ),
    );

    return steps;
  },
};

/** 画面テストの 4 つの手順（この並びで流す。Issue #233） */
export const SCENARIOS: readonly Scenario[] = [warikan, taskBoard, dashboard, persistence];
