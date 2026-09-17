// unit のための付き物（warikan.test.ts と cli.test.ts が共有する）。**実環境には一切届かない。**
//
// data-api（host → gateway → data-api）の代わり。見本（warikan）の意味のうち、採点に要る分だけを返す——
// shareAmount は「額 / 割る人数」、paid / owed / balance は支出からの集計、精算（settle）は差し引きから
// 組んだ送金の並び。採点の算術そのものを試験するのではなく、**runner の経路・順・片付け・失敗の扱い**を
// 試験するための道具である（値の正しさは staging の live 実行と、data-api / spec-engine の unit が担う）。
//
// テストのファイルではない（vitest は *.test.ts だけを集める）ので、ここから import してよい。

import type { ApiRow, ApiSpecBody, ApiTransfer, ApiViewBody, AppSpec, FetchLike } from "@musunest/sdk";
import { DRAFT_SCHEMA_VERSION, EXPENSE_VIEW, MEMBER_VIEW, SETTLEMENT_VIEW } from "../warikan.js";

/** 見本の宣言の写し（tests 用の最小）。7 欄を持ち、SDK の検査に通る形にしてある */
export const FAKE_SPEC: AppSpec = {
  entities: [
    { name: "member", fields: { name: "string" } },
    {
      name: "expense",
      fields: {
        description: "string",
        amount: "number",
        payer: { type: "ref", to: "member" },
        participants: { type: "list", of: "member" },
      },
    },
  ],
  views: [
    { name: MEMBER_VIEW, entity: "member", type: "table" },
    { name: EXPENSE_VIEW, entity: "expense", type: "table", show: ["description", "shareAmount", "amount", "payer"] },
    { name: SETTLEMENT_VIEW, entity: "member", type: "settlement" },
  ],
  actions: [
    { name: "addMember", entity: "member" },
    { name: "addExpense", entity: "expense", kind: "create" },
    { name: "editExpense", entity: "expense", kind: "update" },
    { name: "deleteExpense", entity: "expense", kind: "delete" },
    { name: "deleteMember", entity: "member", kind: "delete" },
  ],
  validations: [
    { name: "positiveAmount", entity: "expense", expression: "amount > 0", message: "金額は 1 円以上にしてください" },
    { name: "someoneShares", entity: "expense", expression: "len(participants) > 0" },
  ],
  computed: [
    { name: "shareAmount", entity: "expense", expression: "amount", type: "number" },
    { name: "paid", entity: "member", expression: "0", type: "number" },
    { name: "owed", entity: "member", expression: "0", type: "number" },
    { name: "balance", entity: "member", expression: "0", type: "number" },
    {
      name: "settlement",
      entity: "member",
      settle: { expense: "expense", amount: "amount", payer: "payer", shares: "participants" },
    },
  ],
  permissions: [
    { name: "read", subject: "minIdentity" },
    { name: "write", subject: "minIdentity" },
  ],
  minIdentity: { mode: "anonymous" },
};

export interface FakeMember {
  readonly id: string;
  readonly name: string;
}

export interface FakeExpense {
  readonly id: string;
  readonly description: string;
  readonly amount: number;
  readonly payer: string;
  readonly participants: readonly string[];
}

export interface FakeCall {
  readonly method: string;
  /** actions の経路の最後の段（action の名前）。それ以外は空 */
  readonly action: string;
  readonly path: string;
}

export interface FakeApiOptions {
  /** spec 応答の sourceSha256。runner が原本から求めた値と一致させる */
  readonly sourceSha256: string;
  readonly schemaVersion?: string;
  /** この description の支出の追加を 500 にする（POST の途中の失敗） */
  readonly failExpense?: string;
  /** この一覧の計算値をずらす（照合の失敗） */
  readonly breakView?: string;
  /** この entity の削除を 500 にする（後片付けの失敗） */
  readonly failDelete?: "expense" | "member";
  /** すべての呼出を例外にする（届かない）。文言に URL や資格情報を載せて、漏えいを試験する */
  readonly unreachable?: string;
  /** 前回の失敗の残りとして置いておくデータ */
  readonly seed?: {
    readonly members?: readonly FakeMember[];
    readonly expenses?: readonly FakeExpense[];
  };
}

export interface FakeApi {
  readonly fetch: FetchLike;
  readonly calls: FakeCall[];
  members(): readonly FakeMember[];
  expenses(): readonly FakeExpense[];
  /** actions の経路の action の名前を、呼ばれた順に返す */
  actions(): readonly string[];
}

const CREATED_AT = "2026-09-16T12:00:00.000Z";
const PERMISSIONS = { read: true, write: true } as const;

export function createFakeApi(options: FakeApiOptions): FakeApi {
  const members: FakeMember[] = [...(options.seed?.members ?? [])];
  const expenses: FakeExpense[] = [...(options.seed?.expenses ?? [])];
  const calls: FakeCall[] = [];
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${String(++counter).padStart(4, "0")}`;

  const shareAmountOf = (expense: FakeExpense): number => Math.floor(expense.amount / Math.max(1, expense.participants.length));

  const statsOf = (id: string): { paid: number; owed: number; balance: number } => {
    const paid = expenses.filter((expense) => expense.payer === id).reduce((sum, expense) => sum + expense.amount, 0);
    const owed = expenses
      .filter((expense) => expense.participants.includes(id))
      .reduce((sum, expense) => sum + shareAmountOf(expense), 0);
    return { paid, owed, balance: paid - owed };
  };

  const memberRow = (member: FakeMember): ApiRow => {
    const stats = statsOf(member.id);
    const offset = options.breakView === MEMBER_VIEW ? 1 : 0;
    return {
      id: member.id,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      fields: { name: member.name },
      computed: { paid: stats.paid, owed: stats.owed, balance: stats.balance + offset },
    };
  };

  const expenseRow = (expense: FakeExpense): ApiRow => {
    const offset = options.breakView === EXPENSE_VIEW ? 1 : 0;
    return {
      id: expense.id,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      fields: {
        description: expense.description,
        amount: expense.amount,
        payer: expense.payer,
        participants: [...expense.participants],
      },
      computed: { headcount: expense.participants.length, shareAmount: shareAmountOf(expense) + offset },
    };
  };

  /** 差し引きから送金の並びを組む（Q13・Q18-7。金額の大きい順に組み合わせる） */
  const transfers = (): ApiTransfer[] => {
    const creditors = members
      .map((member) => ({ id: member.id, amount: statsOf(member.id).balance }))
      .filter((entry) => entry.amount > 0)
      .toSorted((a, b) => b.amount - a.amount);
    const debtors = members
      .map((member) => ({ id: member.id, amount: -statsOf(member.id).balance }))
      .filter((entry) => entry.amount > 0)
      .toSorted((a, b) => b.amount - a.amount);
    const out: ApiTransfer[] = [];
    let creditor = 0;
    let debtor = 0;
    while (creditor < creditors.length && debtor < debtors.length) {
      const to = creditors[creditor];
      const from = debtors[debtor];
      if (to === undefined || from === undefined) break;
      const amount = Math.min(to.amount, from.amount);
      if (amount > 0) out.push({ from: from.id, to: to.id, amount });
      to.amount -= amount;
      from.amount -= amount;
      if (to.amount === 0) creditor++;
      if (from.amount === 0) debtor++;
    }
    return out;
  };

  const specBody = (instanceId: string): ApiSpecBody => ({
    instanceId,
    schemaVersion: options.schemaVersion ?? DRAFT_SCHEMA_VERSION,
    sourceSha256: options.sourceSha256,
    spec: FAKE_SPEC,
    permissions: PERMISSIONS,
    actions: FAKE_SPEC.actions,
  });

  const memberActions = FAKE_SPEC.actions.filter((action) => action.entity === "member");
  const expenseActions = FAKE_SPEC.actions.filter((action) => action.entity === "expense");

  const viewBody = (instanceId: string, view: string): ApiViewBody => {
    if (view === EXPENSE_VIEW) {
      return {
        instanceId,
        view: EXPENSE_VIEW,
        entity: "expense",
        fields: ["description", "amount", "payer", "participants"],
        computed: ["shareAmount"],
        permissions: PERMISSIONS,
        actions: expenseActions,
        rows: expenses.map(expenseRow),
      };
    }
    const rows = members.map(memberRow);
    if (view === SETTLEMENT_VIEW) {
      return {
        instanceId,
        view: SETTLEMENT_VIEW,
        entity: "member",
        fields: ["name"],
        computed: ["paid", "owed", "balance"],
        permissions: PERMISSIONS,
        actions: memberActions,
        rows,
        settlement: options.breakView === SETTLEMENT_VIEW ? [] : transfers(),
      };
    }
    return {
      instanceId,
      view: MEMBER_VIEW,
      entity: "member",
      fields: ["name"],
      computed: ["paid", "owed", "balance"],
      permissions: PERMISSIONS,
      actions: memberActions,
      rows,
    };
  };

  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  const rejected = (): Response => json({ error: "INPUT_REJECTED", fields: [], validations: [] }, 422);

  const handleAction = (action: string, input: Record<string, unknown>): Response => {
    if (action === "addMember") {
      const name = input["name"];
      if (typeof name !== "string") return rejected();
      const member: FakeMember = { id: nextId("member"), name };
      members.push(member);
      return json(memberRow(member), 201);
    }
    if (action === "addExpense") {
      const description = input["description"];
      const amount = input["amount"];
      const payer = input["payer"];
      const participants = input["participants"];
      if (options.failExpense === description) return json({ error: "INVALID_RESPONSE" }, 500);
      if (typeof description !== "string" || typeof amount !== "number" || typeof payer !== "string" || !Array.isArray(participants)) {
        return rejected();
      }
      const expense: FakeExpense = { id: nextId("expense"), description, amount, payer, participants: participants as string[] };
      expenses.push(expense);
      return json(expenseRow(expense), 201);
    }
    if (action === "deleteExpense" || action === "deleteMember") {
      const entity = action === "deleteExpense" ? "expense" : "member";
      if (options.failDelete === entity) return json({ error: "INVALID_RESPONSE" }, 500);
      const id = input["id"];
      if (typeof id !== "string") return rejected();
      if (entity === "expense") {
        const at = expenses.findIndex((expense) => expense.id === id);
        if (at < 0) return json({ error: "NOT_FOUND" }, 404);
        expenses.splice(at, 1);
      } else {
        const at = members.findIndex((member) => member.id === id);
        if (at < 0) return json({ error: "NOT_FOUND" }, 404);
        // #109：支出から参照されているメンバーは消せない（支出を先に消さないと 409 で残る）
        const usedByPayer = expenses.some((expense) => expense.payer === id);
        const usedByShares = expenses.some((expense) => expense.participants.includes(id));
        if (usedByPayer || usedByShares) {
          return json(
            {
              error: "REFERENCE_IN_USE",
              references: [
                ...(usedByPayer ? [{ entity: "expense", field: "payer", count: 1 }] : []),
                ...(usedByShares ? [{ entity: "expense", field: "participants", count: 1 }] : []),
              ],
            },
            409,
          );
        }
        members.splice(at, 1);
      }
      return json({ entity, id, deleted: true });
    }
    return json({ error: "NOT_FOUND" }, 404);
  };

  const handle = (url: string, init: RequestInit): Response => {
    const path = new URL(url).pathname;
    const parts = path.split("/").filter((part) => part !== "");
    const instanceId = parts[2] === undefined ? "" : decodeURIComponent(parts[2]);
    const section = parts[3];
    const name = parts[4] === undefined ? "" : decodeURIComponent(parts[4]);
    calls.push({ method: init.method ?? "GET", action: section === "actions" ? name : "", path });
    if (section === "spec") return json(specBody(instanceId));
    if (section === "views") return json(viewBody(instanceId, name));
    if (section === "actions") {
      const raw = typeof init.body === "string" ? init.body : "{}";
      return handleAction(name, JSON.parse(raw) as Record<string, unknown>);
    }
    return json({ error: "NOT_FOUND" }, 404);
  };

  return {
    fetch: (url, init) => {
      if (options.unreachable !== undefined) return Promise.reject(new Error(options.unreachable));
      try {
        return Promise.resolve(handle(url, init));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error("test double failed"));
      }
    },
    calls,
    members: () => members,
    expenses: () => expenses,
    actions: () => calls.filter((call) => call.action !== "").map((call) => call.action),
  };
}
