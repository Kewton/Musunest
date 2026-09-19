// staging に置いた見本（タスク管理）を採点する runner（Issue #159）。
//
// host と同じ型付きクライアント（@musunest/sdk）で、staging の host の /api 経路（spec・view・action）を通る。
//
// 確かめるもの:
//   1. 原本（packages/appspec-schema/samples/task-board/app.spec.yaml）の SHA-256 が、staging の spec 応答の
//      `sourceSha256` と一致し、版が草案の版と一致すること。**違えば、採点も書込もせずに止める**
//   2. **時計に依存しない値だけ**（workspace/mvp/m1/00-open-questions.md Q16・Q17）: ボードの列（`columns`
//      が指す選択肢のキーの順）、タスクの項目（題・状態・担当・期限）、メンバーの `openTasks`、
//      `finish`（`set` と `when`）の結果。**`overdue` は時計に依るので、ここでは採点しない**——
//      時計を差し込む unit（data-api の app-api.test.ts）で採点する
//   3. どの一覧も `getView` が ok で返すこと（配信側が M1.3 の語彙を読めること。#145・#154 と同じ穴）
//
// 専用インスタンス（固定 ID）だけを使う。デモ・窓口のインスタンスには触らない。
// 片付けは**タスクを先に消す**（task は member を参照するので、逆には消せない）。
// **member は消さずに名前で再利用する**——見本は `member` の削除の操作を宣言していないためである。
// ログに URL・ホスト名・資格情報を出さない。応答の生の本文も出さない。

import type { ApiRow, ApiSpecBody, ApiViewBody, MusunestClient } from "@musunest/sdk";
import { actionNameFor, describeError, errorKind, sha256Hex } from "./warikan.js";

/** 見本の原本の置き場（リポジトリの直下からの相対パス） */
export const SAMPLE_DIRECTORY = "packages/appspec-schema/samples/task-board";
export const SAMPLE_FILE = `${SAMPLE_DIRECTORY}/app.spec.yaml`;

/** 見本の一覧の名前（宣言が正本で、ここは写し） */
export const BOARD_VIEW = "board";
export const LIST_VIEW = "list";
export const MEMBERS_VIEW = "members";

/** 使うメンバー（登録した順に A・B・C） */
export const MEMBER_NAMES = ["A", "B", "C"] as const;

/** 作るタスクと、時計に依存しない期待値（workspace/mvp/m1/02-l2-spec-examples.md §3.3 の入力） */
export const EXPECTED_TASKS: readonly {
  readonly title: string;
  readonly status: string;
  readonly member: string;
  readonly due: string;
}[] = [
  { title: "宿の予約", status: "doing", member: "A", due: "2026-09-20" },
  { title: "しおり作り", status: "todo", member: "B", due: "2026-09-10" },
  { title: "レンタカー", status: "done", member: "C", due: "2026-09-25" },
];

/** ボードの列の並び（`columns: status` が指す選択肢のキーの順） */
export const EXPECTED_COLUMNS = ["todo", "doing", "done"] as const;

/** メンバーごとの `openTasks`（時計に依存しない） */
export const EXPECTED_OPEN_TASKS: readonly { readonly name: string; readonly openTasks: number }[] = [
  { name: "A", openTasks: 1 },
  { name: "B", openTasks: 1 },
  { name: "C", openTasks: 1 },
];

/** `finish`（`set` と `when`）を実経路で確かめるタスク */
export const TASK_TO_FINISH = "しおり作り";

/** ボードの強調（`highlight`）が指す計算の名前。**値は時計に依るので採点しない**（載っていることだけ見る） */
export const HIGHLIGHT_NAME = "overdue";

export interface TaskBoardIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface TaskBoardDeps extends TaskBoardIo {
  /** host と同じ型付きクライアント（宛先は呼ぶ側が決める。ここは URL を知らない） */
  readonly client: MusunestClient;
  /** e2e 専用のインスタンスの ID */
  readonly instanceId: string;
  /** 原本（app.spec.yaml）を読んだ文字列。SHA-256 はここから求める */
  readonly source: string;
  /** 期待する版（呼ぶ側が渡す） */
  readonly expectedSchemaVersion: string;
}

export interface TaskBoardResult {
  /** SHA・値・後片付けのすべてが成功したときだけ true（終了 0 の条件） */
  readonly ok: boolean;
  /** 人が読む理由。**値（URL・ホスト名・資格情報）を含めない** */
  readonly reason: string;
}

const fail = (reason: string): TaskBoardResult => ({ ok: false, reason });

const rowsOf = async (
  client: MusunestClient,
  instanceId: string,
  view: string,
): Promise<{ readonly ok: true; readonly body: ApiViewBody } | { readonly ok: false; readonly reason: string }> => {
  const result = await client.getView(instanceId, view);
  return result.ok ? { ok: true, body: result.value } : { ok: false, reason: `一覧（${view}）を読めない（${describeError(result.error)}）` };
};

/** タスクをすべて消す（**member より先**。member は消さない——見本に削除の操作が無い） */
async function cleanTasks(
  deps: TaskBoardDeps,
  deleteTask: string,
): Promise<TaskBoardResult> {
  const listed = await rowsOf(deps.client, deps.instanceId, LIST_VIEW);
  if (!listed.ok) return fail(listed.reason);
  for (const row of listed.body.rows) {
    const deleted = await deps.client.deleteRecord(deps.instanceId, deleteTask, row.id);
    if (!deleted.ok) return fail(`タスク（${row.id}）を消せない（${describeError(deleted.error)}）`);
  }
  return { ok: true, reason: "" };
}

/** メンバー A・B・C を、名前で引いて足りない分だけ登録する（残っていれば再利用する） */
async function ensureMembers(
  deps: TaskBoardDeps,
  addMember: string,
): Promise<{ readonly ok: true; readonly members: ReadonlyMap<string, string> } | { readonly ok: false; readonly reason: string }> {
  const listed = await rowsOf(deps.client, deps.instanceId, MEMBERS_VIEW);
  if (!listed.ok) return { ok: false, reason: listed.reason };
  const found = new Map<string, string>();
  for (const row of listed.body.rows) {
    const name = row.fields["name"];
    if (typeof name === "string") found.set(name, row.id);
  }
  for (const name of MEMBER_NAMES) {
    if (found.has(name)) continue;
    const created = await deps.client.addRecord(deps.instanceId, addMember, { name });
    if (!created.ok) return { ok: false, reason: `メンバー（${name}）を登録できない（${describeError(created.error)}）` };
    found.set(name, created.value.id);
  }
  return { ok: true, members: found };
}

/** 3 つのタスクを作る（`status` は入力で指定する。`default` は unit の採点で見る） */
async function createTasks(
  deps: TaskBoardDeps,
  addTask: string,
  members: ReadonlyMap<string, string>,
): Promise<{ readonly ok: true; readonly tasks: ReadonlyMap<string, string> } | { readonly ok: false; readonly reason: string }> {
  const tasks = new Map<string, string>();
  for (const expected of EXPECTED_TASKS) {
    const assignee = members.get(expected.member);
    if (assignee === undefined) return { ok: false, reason: `担当（${expected.member}）の ID を記録できていない` };
    const created = await deps.client.addRecord(deps.instanceId, addTask, {
      title: expected.title,
      status: expected.status,
      assignee,
      due: expected.due,
      memo: "",
    });
    if (!created.ok) return { ok: false, reason: `タスク（${expected.title}）を登録できない（${describeError(created.error)}）` };
    tasks.set(expected.title, created.value.id);
  }
  return { ok: true, tasks };
}

/** 一覧の行を、題 → 行 にする */
const byTitle = (rows: readonly ApiRow[]): ReadonlyMap<string, ApiRow> => {
  const index = new Map<string, ApiRow>();
  for (const row of rows) {
    const title = row.fields["title"];
    if (typeof title === "string") index.set(title, row);
  }
  return index;
};

/** ボードの宣言（種類・`columns`・`highlight`）と、`columns` が指す選択肢のキーの順を見る */
function checkBoardDeclaration(spec: ApiSpecBody, problems: string[]): void {
  const view = spec.spec.views.find((candidate) => candidate.name === BOARD_VIEW);
  if (view === undefined) {
    problems.push(`宣言に一覧（${BOARD_VIEW}）が無い`);
    return;
  }
  if (view.type !== "board") problems.push(`一覧（${BOARD_VIEW}）の type が board でない`);
  if (view.columns !== "status") problems.push(`一覧（${BOARD_VIEW}）の columns が status でない`);
  if (view.highlight !== HIGHLIGHT_NAME) problems.push(`一覧（${BOARD_VIEW}）の highlight が ${HIGHLIGHT_NAME} でない`);
  const task = spec.spec.entities.find((entity) => entity.name === "task");
  const status = task?.fields["status"];
  if (typeof status !== "object" || status === null || Array.isArray(status) || status.type !== "enum") {
    problems.push("task の status が選択肢（enum）でない");
    return;
  }
  const keys = Object.keys(status.options);
  if (keys.join(",") !== EXPECTED_COLUMNS.join(",")) {
    problems.push(`status の選択肢の並びが ${EXPECTED_COLUMNS.join("・")} でない（${keys.join("・")}）`);
  }
  if (status.default !== "todo") problems.push("task の status の既定値が todo でない");
}

/** 一覧の行の項目（題・状態・担当・期限）を、時計に依存しない期待値と比べる */
function checkTaskRows(
  rows: readonly ApiRow[],
  members: ReadonlyMap<string, string>,
  view: string,
  problems: string[],
): void {
  const nameById = new Map([...members].map(([name, id]) => [id, name]));
  if (rows.length !== EXPECTED_TASKS.length) {
    problems.push(`一覧（${view}）の行数が ${EXPECTED_TASKS.length} でない（${rows.length}）`);
  }
  const index = byTitle(rows);
  for (const expected of EXPECTED_TASKS) {
    const row = index.get(expected.title);
    if (row === undefined) {
      problems.push(`一覧（${view}）にタスク（${expected.title}）の行が無い`);
      continue;
    }
    if (row.fields["status"] !== expected.status) problems.push(`タスク（${expected.title}）の状態が ${expected.status} でない`);
    if (row.fields["due"] !== expected.due) problems.push(`タスク（${expected.title}）の期限が ${expected.due} でない`);
    if (nameById.get(String(row.fields["assignee"])) !== expected.member) {
      problems.push(`タスク（${expected.title}）の担当が ${expected.member} でない`);
    }
  }
  // ボードは `highlight` が指す真偽の値を行に載せる（値は時計に依るので、載っていることだけ見る）
  if (view === BOARD_VIEW) {
    for (const row of rows) {
      const highlighted = row.computed[HIGHLIGHT_NAME];
      if (typeof highlighted !== "boolean") problems.push(`タスク（${String(row.fields["title"])}）の ${HIGHLIGHT_NAME} が真偽でない`);
    }
  }
}

/** メンバーの `openTasks` を比べる（時計に依存しない） */
function checkMembers(rows: readonly ApiRow[], problems: string[]): void {
  if (rows.length !== EXPECTED_OPEN_TASKS.length) {
    problems.push(`一覧（${MEMBERS_VIEW}）の行数が ${EXPECTED_OPEN_TASKS.length} でない（${rows.length}）`);
  }
  const byName = new Map<string, ApiRow>();
  for (const row of rows) {
    const name = row.fields["name"];
    if (typeof name === "string") byName.set(name, row);
  }
  for (const expected of EXPECTED_OPEN_TASKS) {
    const row = byName.get(expected.name);
    if (row === undefined) {
      problems.push(`メンバー（${expected.name}）の行が無い`);
      continue;
    }
    if (row.computed["openTasks"] !== expected.openTasks) {
      problems.push(`メンバー（${expected.name}）の openTasks が ${expected.openTasks} でない`);
    }
  }
}

/** 時計に依存しない値を、API の値として比べる。問題があればその一覧を返す */
async function score(deps: TaskBoardDeps, spec: ApiSpecBody, members: ReadonlyMap<string, string>): Promise<TaskBoardResult> {
  const problems: string[] = [];
  checkBoardDeclaration(spec, problems);

  const board = await rowsOf(deps.client, deps.instanceId, BOARD_VIEW);
  if (!board.ok) return fail(board.reason);
  const list = await rowsOf(deps.client, deps.instanceId, LIST_VIEW);
  if (!list.ok) return fail(list.reason);
  const memberRows = await rowsOf(deps.client, deps.instanceId, MEMBERS_VIEW);
  if (!memberRows.ok) return fail(memberRows.reason);

  checkTaskRows(board.body.rows, members, BOARD_VIEW, problems);
  checkTaskRows(list.body.rows, members, LIST_VIEW, problems);
  checkMembers(memberRows.body.rows, problems);

  return problems.length > 0 ? fail(problems.join(" / ")) : { ok: true, reason: "" };
}

/** `finish`（`set` と `when`）でタスクを完了にし、状態が変わることを確かめる */
async function checkFinish(
  deps: TaskBoardDeps,
  finish: string,
  tasks: ReadonlyMap<string, string>,
): Promise<TaskBoardResult> {
  const id = tasks.get(TASK_TO_FINISH);
  if (id === undefined) return fail(`タスク（${TASK_TO_FINISH}）の ID を記録できていない`);
  const result = await deps.client.setRecord(deps.instanceId, finish, id);
  if (!result.ok) return fail(`タスク（${TASK_TO_FINISH}）を完了にできない（${describeError(result.error)}）`);
  if (result.value.fields["status"] !== "done") return fail(`タスク（${TASK_TO_FINISH}）の状態が done でない`);
  return { ok: true, reason: "" };
}

/** spec 応答から使う操作の名前を引く */
function actionsOf(spec: ApiSpecBody, problems: string[]): { readonly addMember: string; readonly addTask: string; readonly deleteTask: string; readonly finish: string } | null {
  const addMember = actionNameFor(spec, "member", "create");
  const addTask = actionNameFor(spec, "task", "create");
  const deleteTask = actionNameFor(spec, "task", "delete");
  const finish = spec.actions.find((action) => action.entity === "task" && action.name === "finish")?.name;
  if (addMember === undefined || addTask === undefined || deleteTask === undefined || finish === undefined) {
    problems.push("宣言に、採点と後片付けに要る action が無い（member の create、task の create / delete / finish）");
    return null;
  }
  return { addMember, addTask, deleteTask, finish };
}

/**
 * staging の専用インスタンスで、宣言の照合 → 後片付け → 作る → 採点 → `finish` → 後片付け を 1 周する。
 *
 * 順は「宣言と原本 SHA の照合 →（前回のタスクを片付ける）→ メンバーをそろえる → タスクを作る →
 * 採点 → `finish` → 片付ける」である。**照合に通らない間は 1 つも書かない。**
 */
export async function runTaskBoard(deps: TaskBoardDeps): Promise<TaskBoardResult> {
  const { client, instanceId, out } = deps;

  // 1. 宣言を読む（読み取りだけ。まだ 1 つも書かない）
  const spec = await client.getSpec(instanceId);
  if (!spec.ok) return fail(`宣言を読めない（${describeError(spec.error)}）`);

  // 2. 原本 SHA-256 と版の照合。**違えば書込もしない**
  const expectedSha = await sha256Hex(deps.source);
  if (spec.value.sourceSha256 !== expectedSha) {
    return fail("原本 SHA-256 が staging の宣言と一致しない（staging の見本がリポジトリと違う）");
  }
  if (spec.value.schemaVersion !== deps.expectedSchemaVersion) {
    return fail(`版が草案の版と一致しない（期待 ${deps.expectedSchemaVersion}）`);
  }
  out(`e2e: 原本 SHA-256 と版（${spec.value.schemaVersion}）が一致した`);

  const problems: string[] = [];
  const actions = actionsOf(spec.value, problems);
  if (actions === null) return fail(problems.join(" / "));

  let result: TaskBoardResult = fail("採点に到達しなかった");
  try {
    // 3. 前回のタスクを片付ける（専用インスタンスのタスクは、すべてこの e2e のもの）
    const before = await cleanTasks(deps, actions.deleteTask);
    if (!before.ok) {
      result = fail(`開始時の片付けに失敗した（${before.reason}）`);
    } else {
      out("e2e: 前回までのタスク（あれば）を片付けた");

      // 4. メンバーをそろえる（残っていれば名前で再利用する）
      const ensured = await ensureMembers(deps, actions.addMember);
      if (!ensured.ok) {
        result = fail(ensured.reason);
      } else {
        // 5. タスクを作る
        const created: { ok: true; tasks: ReadonlyMap<string, string> } | { ok: false; reason: string } = await createTasks(
          deps,
          actions.addTask,
          ensured.members,
        );
        if (!created.ok) {
          result = fail(created.reason);
        } else {
          out(`e2e: メンバー ${MEMBER_NAMES.join("・")} とタスク（${EXPECTED_TASKS.map((task) => task.title).join("・")}）をそろえた`);

          // 6. 採点（時計に依存しない値だけ）
          result = await score(deps, spec.value, ensured.members);
          if (result.ok) out("e2e: 採点した（ボードの列・タスクの項目・openTasks）");

          // 7. `finish`（set と when）を実経路で確かめる
          if (result.ok) {
            const finished = await checkFinish(deps, actions.finish, created.tasks);
            if (!finished.ok) result = finished;
            else out(`e2e: ${TASK_TO_FINISH} を finish で完了にした（set と when）`);
          }
        }
      }
    }
  } catch (e) {
    result = fail(`予期しない失敗（${errorKind(e)}）`);
  }

  // 8. 後片付け（失敗しても必ず行う）。**ここが失敗したら成功にしない**
  const after = await cleanTasks(deps, actions.deleteTask);
  if (!after.ok) {
    return fail(result.reason === "" ? `後片付けに失敗した（${after.reason}）` : `${result.reason} / 後片付けにも失敗した（${after.reason}）`);
  }
  out("e2e: 専用データを片付けた（タスク。メンバーは名前で再利用する）");
  return result;
}
