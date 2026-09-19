// unit のための付き物（task-board.test.ts と cli.test.ts が共有する）。**実環境には一切届かない。**
//
// data-api（host → gateway → data-api）の代わり。見本（タスク管理）の意味のうち、採点に要る分だけを返す——
// メンバーの `openTasks` は担当しているタスクの数、`finish` は `set` で状態を `done` にする。
// 採点の算術そのものを試験するのではなく、**runner の経路・順・片付け・失敗の扱い**を試験するための道具である。
//
// テストのファイルではない（vitest は *.test.ts だけを集める）ので、ここから import してよい。

import type {
  ApiRow,
  ApiSpecBody,
  ApiValue,
  ApiViewBody,
  AppSpec,
  ClientResult,
  MusunestClient,
} from "@musunest/sdk";
import {
  BOARD_VIEW,
  EXPECTED_TASKS,
  HIGHLIGHT_NAME,
  LIST_VIEW,
  MEMBER_NAMES,
  MEMBERS_VIEW,
} from "../task-board.js";
import { DRAFT_SCHEMA_VERSION } from "../warikan.js";

/** 見本の宣言の写し（tests 用の最小）。M1.3 の語彙（enum・default・date・set・when・board・list・filters）を持つ */
export const FAKE_SPEC: AppSpec = {
  entities: [
    { name: "member", fields: { name: "string" } },
    {
      name: "task",
      fields: {
        title: "string",
        status: {
          type: "enum",
          options: { todo: "未着手", doing: "進行中", done: "完了" },
          default: "todo",
        },
        assignee: { type: "ref", to: "member" },
        due: "date",
        memo: "string",
      },
    },
  ],
  views: [
    { name: BOARD_VIEW, entity: "task", type: "board", columns: "status", highlight: HIGHLIGHT_NAME },
    {
      name: LIST_VIEW,
      entity: "task",
      type: "list",
      show: ["title", "status", "assignee", "due"],
      filters: ["assignee", "status"],
    },
    { name: MEMBERS_VIEW, entity: "member", type: "table", show: ["name", "openTasks"] },
  ],
  actions: [
    { name: "addTask", entity: "task", kind: "create" },
    { name: "editTask", entity: "task", kind: "update" },
    { name: "start", entity: "task", kind: "update", set: { status: "doing" }, when: 'status == "todo"' },
    { name: "finish", entity: "task", kind: "update", set: { status: "done" }, when: 'status != "done"' },
    { name: "deleteTask", entity: "task", kind: "delete" },
    { name: "addMember", entity: "member", kind: "create" },
  ],
  validations: [],
  computed: [
    { name: HIGHLIGHT_NAME, entity: "task", expression: "due < today()", type: "boolean" },
    {
      name: "openTasks",
      entity: "member",
      aggregate: { kind: "count", entity: "task", name: null, where: { assignee: { op: "equals" } } },
      type: "number",
    },
  ],
  permissions: [
    { name: "read", subject: "minIdentity" },
    { name: "write", subject: "minIdentity" },
  ],
  minIdentity: { mode: "anonymous" },
};

const CREATED_AT = "2026-09-19T00:00:00.000Z";
const PERMISSIONS = { read: true, write: true } as const;

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });
const err = (code: "INVALID_RESPONSE" | "NOT_FOUND"): ClientResult<never> => ({
  ok: false,
  error: { status: 500, code, fields: [], validations: [] },
});

export interface FakeTask {
  readonly id: string;
  readonly title: string;
  status: string;
  readonly assignee: string;
  readonly due: string;
  readonly memo: string;
}

export interface FakeMember {
  readonly id: string;
  readonly name: string;
}

export interface FakeTaskBoardCall {
  readonly kind: "getSpec" | "getView" | "add" | "delete" | "set";
  readonly name: string;
}

export interface FakeTaskBoardOptions {
  /** spec 応答の sourceSha256。runner が原本から求めた値と一致させる */
  readonly sourceSha256: string;
  readonly schemaVersion?: string;
  /** この一覧だけ、計算値や行をずらす（照合の失敗） */
  readonly breakView?: string;
  /** この題のタスクの登録を 500 にする（作る途中の失敗） */
  readonly failTask?: string;
  /** この題のタスクの finish（set）を 500 にする */
  readonly failFinish?: string;
  /** この題のタスクの削除を 500 にする（後片付けの失敗） */
  readonly failDelete?: string;
  /** はじめから置いておくデータ（前回の失敗の残り） */
  readonly seed?: { readonly members?: readonly FakeMember[]; readonly tasks?: readonly FakeTask[] };
  /** すべての呼出を例外にする（届かない） */
  readonly unreachable?: string;
}

export interface FakeTaskBoardApi {
  readonly client: MusunestClient;
  readonly calls: FakeTaskBoardCall[];
  members(): readonly FakeMember[];
  tasks(): readonly FakeTask[];
  /** 呼ばれた操作の名前（add・delete・set）を、呼ばれた順に返す */
  actions(): readonly string[];
}

export function createFakeTaskBoardApi(options: FakeTaskBoardOptions): FakeTaskBoardApi {
  const members: FakeMember[] = [...(options.seed?.members ?? [])];
  const tasks: FakeTask[] = [...(options.seed?.tasks ?? [])];
  const calls: FakeTaskBoardCall[] = [];
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${String(++counter).padStart(4, "0")}`;

  const openTasksOf = (memberId: string): number => tasks.filter((task) => task.assignee === memberId).length;

  const taskRow = (task: FakeTask, withHighlight: boolean): ApiRow => ({
    id: task.id,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    fields: {
      title: task.title,
      status: task.status,
      assignee: task.assignee,
      due: task.due,
      memo: task.memo,
    },
    computed: withHighlight ? { [HIGHLIGHT_NAME]: task.due < "2026-09-15" } : {},
  });

  const memberRow = (member: FakeMember): ApiRow => ({
    id: member.id,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    fields: { name: member.name },
    computed: { openTasks: openTasksOf(member.id) },
  });

  const specBody = (instanceId: string): ApiSpecBody => ({
    instanceId,
    schemaVersion: options.schemaVersion ?? DRAFT_SCHEMA_VERSION,
    sourceSha256: options.sourceSha256,
    spec: FAKE_SPEC,
    permissions: PERMISSIONS,
    actions: FAKE_SPEC.actions,
  });

  const viewBody = (instanceId: string, view: string): ApiViewBody | null => {
    if (view === BOARD_VIEW) {
      const rows = tasks.map((task) => taskRow(task, true));
      return {
        instanceId,
        view,
        entity: "task",
        fields: ["title", "status", "assignee", "due", "memo"],
        computed: [],
        permissions: PERMISSIONS,
        actions: FAKE_SPEC.actions.filter((action) => action.entity === "task"),
        rows:
          options.breakView === BOARD_VIEW
            ? rows.map((row) => ({ ...row, fields: { ...row.fields, status: "todo" } }))
            : rows,
      };
    }
    if (view === LIST_VIEW) {
      return {
        instanceId,
        view,
        entity: "task",
        fields: ["title", "status", "assignee", "due", "memo"],
        computed: [],
        permissions: PERMISSIONS,
        actions: FAKE_SPEC.actions.filter((action) => action.entity === "task"),
        rows: options.breakView === LIST_VIEW ? [] : tasks.map((task) => taskRow(task, false)),
      };
    }
    if (view === MEMBERS_VIEW) {
      return {
        instanceId,
        view,
        entity: "member",
        fields: ["name"],
        computed: ["openTasks"],
        permissions: PERMISSIONS,
        actions: FAKE_SPEC.actions.filter((action) => action.entity === "member"),
        rows: members.map(memberRow),
      };
    }
    return null;
  };

  const client: MusunestClient = {
    getSpec: async (instanceId) => {
      calls.push({ kind: "getSpec", name: "spec" });
      if (options.unreachable !== undefined) throw new Error(options.unreachable);
      return ok(specBody(instanceId));
    },
    getView: async (instanceId, name) => {
      calls.push({ kind: "getView", name });
      const body = viewBody(instanceId, name);
      return body === null ? err("NOT_FOUND") : ok(body);
    },
    addRecord: async (instanceId, name, input: Readonly<Record<string, ApiValue>>) => {
      calls.push({ kind: "add", name });
      if (name === "addMember") {
        const member: FakeMember = { id: nextId("member"), name: String(input["name"]) };
        members.push(member);
        return ok(memberRow(member));
      }
      const title = String(input["title"]);
      if (options.failTask === title) return err("INVALID_RESPONSE");
      const task: FakeTask = {
        id: nextId("task"),
        title,
        status: String(input["status"]),
        assignee: String(input["assignee"]),
        due: String(input["due"]),
        memo: String(input["memo"]),
      };
      tasks.push(task);
      return ok(taskRow(task, false));
    },
    deleteRecord: async (_instanceId, name, id) => {
      calls.push({ kind: "delete", name });
      const at = tasks.findIndex((task) => task.id === id);
      if (at < 0) return err("NOT_FOUND");
      if (options.failDelete === tasks[at]?.title) return err("INVALID_RESPONSE");
      const [removed] = tasks.splice(at, 1);
      return ok({ entity: "task", id: removed?.id ?? id, deleted: true as const });
    },
    setRecord: async (_instanceId, name, id) => {
      calls.push({ kind: "set", name });
      const task = tasks.find((candidate) => candidate.id === id);
      if (task === undefined) return err("NOT_FOUND");
      if (options.failFinish === task.title) return err("INVALID_RESPONSE");
      if (name === "finish") task.status = "done";
      return ok(taskRow(task, false));
    },
  };

  return {
    client,
    calls,
    members: () => members,
    tasks: () => tasks,
    actions: () => calls.filter((call) => call.kind === "add" || call.kind === "delete" || call.kind === "set").map((call) => call.name),
  };
}

/** 期待どおりのメンバー（A・B・C）を名前で置いておく（再利用の試験に使う） */
export const seededMembers = (): readonly FakeMember[] =>
  MEMBER_NAMES.map((name, index) => ({ id: `member-seed-${index}`, name }));

/** 期待どおりのタスクを、`EXPECTED_TASKS` から作る（残っているデータの試験に使う） */
export const seededTasks = (memberIds: readonly string[]): readonly FakeTask[] =>
  EXPECTED_TASKS.map((task, index) => ({
    id: `task-seed-${index}`,
    title: task.title,
    status: task.status,
    assignee: memberIds[index] ?? memberIds[0] ?? "",
    due: task.due,
    memo: "",
  }));
