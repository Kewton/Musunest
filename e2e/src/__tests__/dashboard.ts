// unit のための付き物（dashboard.test.ts が使う）。**実環境には一切届かない。**
//
// data-api（host → gateway → data-api）の代わり。見本（ダッシュボード）の意味のうち、採点に要る分だけを
// 返す——活動の行の `attendeeCount` は参加した人の数、見出しごとの集計（`activitiesByKind`）は種類ごとの
// 件数、順位（`topActivities`）は `attendeeCount` の降順（同数は登録した順）である。**採点の算術そのものを
// 試験するのではなく、runner の経路・順・片付け・失敗の扱いを試験するための道具である**（値の正しさは
// staging の live 実行と、data-api / spec-engine の unit が担う）。
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
import { DRAFT_SCHEMA_VERSION } from "../warikan.js";
import { EXPECTED_KINDS, MEMBERS_VIEW } from "../dashboard.js";

/** 見本の宣言の写し（tests 用の最小）。M1.4 の語彙（scope: app・groups・dashboard・ranking）を持つ */
export const FAKE_SPEC: AppSpec = {
  entities: [
    { name: "member", fields: { name: "string" } },
    {
      name: "activity",
      fields: {
        kind: { type: "enum", options: { practice: "練習", match: "試合", party: "飲み会" } },
        date: "date",
        attendees: { type: "list", of: "member" },
        cost: "number",
      },
    },
  ],
  views: [
    {
      name: "dashboard",
      type: "dashboard",
      widgets: [
        { type: "number", value: "activityCount", unit: "回" },
        { type: "bar", value: "activitiesByMonth", unit: "回" },
        { type: "ranking", name: "topActivities", entity: "activity", by: "attendeeCount", show: ["attendeeCount"] },
      ],
    },
    { name: "activities", type: "list", entity: "activity", show: ["kind", "date", "attendees", "cost", "attendeeCount"] },
    { name: MEMBERS_VIEW, type: "list", entity: "member", show: ["name"] },
  ],
  actions: [
    { name: "addMember", entity: "member", kind: "create" },
    { name: "addActivity", entity: "activity", kind: "create" },
    { name: "deleteActivity", entity: "activity", kind: "delete" },
    { name: "deleteMember", entity: "member", kind: "delete" },
  ],
  validations: [],
  computed: [
    { name: "attendeeCount", entity: "activity", expression: "len(attendees)", type: "number" },
    { name: "activityCount", scope: "app", aggregate: { kind: "count", entity: "activity", name: null, where: {} }, type: "number" },
    {
      name: "activitiesByKind",
      aggregate: { kind: "count", entity: "activity", name: null, where: {}, groupBy: { field: "kind", month: false } },
      type: "groups",
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
const TOP = 5;

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });
const rejected = (fields: readonly string[]): ClientResult<never> => ({
  ok: false,
  error: { status: 422, code: "INPUT_REJECTED", fields, validations: [] },
});
const refInUse = (): ClientResult<never> => ({
  ok: false,
  error: { status: 409, code: "REFERENCE_IN_USE", fields: [], validations: [], references: [] },
});

export interface FakeMember {
  readonly id: string;
  readonly name: string;
}

export interface FakeActivity {
  readonly id: string;
  readonly kind: string;
  readonly date: string;
  readonly attendees: readonly string[];
  readonly cost: number;
}

export interface FakeCall {
  readonly kind: "getSpec" | "getView" | "add" | "delete";
  readonly name: string;
}

export interface FakeDashboardOptions {
  /** spec 応答の sourceSha256。runner が原本から求めた値と一致させる */
  readonly sourceSha256: string;
  readonly schemaVersion?: string;
  /** この一覧だけ、計算値や行をずらす（照合の失敗） */
  readonly breakView?: string;
  /** この date の活動の登録を 500 にする（作る途中の失敗） */
  readonly failActivity?: string;
  /** この entity の削除を 500 にする（後片付けの失敗） */
  readonly failDelete?: "activity" | "member";
  /** はじめから置いておくデータ（前回の失敗の残り） */
  readonly seed?: { readonly members?: readonly FakeMember[]; readonly activities?: readonly FakeActivity[] };
  /** すべての呼出を例外にする（届かない） */
  readonly unreachable?: string;
}

export interface FakeDashboardApi {
  readonly client: MusunestClient;
  readonly calls: FakeCall[];
  members(): readonly FakeMember[];
  activities(): readonly FakeActivity[];
  /** 呼ばれた操作の名前（add・delete）を、呼ばれた順に返す */
  actions(): readonly string[];
}

export function createFakeDashboardApi(options: FakeDashboardOptions): FakeDashboardApi {
  const members: FakeMember[] = [...(options.seed?.members ?? [])];
  const activities: FakeActivity[] = [...(options.seed?.activities ?? [])];
  const calls: FakeCall[] = [];
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${String(++counter).padStart(4, "0")}`;

  const attendeeCount = (activity: FakeActivity): number => activity.attendees.length;

  const activityRow = (activity: FakeActivity, offset: number): ApiRow => ({
    id: activity.id,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    fields: {
      kind: activity.kind,
      date: activity.date,
      attendees: [...activity.attendees],
      cost: activity.cost,
    },
    computed: { attendeeCount: attendeeCount(activity) + offset },
  });

  /** メンバーの行（見本の一覧 `members` が返す形。項目は `name` だけ） */
  const memberRow = (member: FakeMember): ApiRow => ({
    id: member.id,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    fields: { name: member.name },
    computed: {},
  });

  /** 種類ごとの件数（`options` の順。0 の見出しも返す） */
  const byKind = (): readonly { readonly heading: string; readonly value: number }[] =>
    EXPECTED_KINDS.map((kind) => ({
      heading: kind,
      value: activities.filter((activity) => activity.kind === kind).length,
    }));

  /** `attendeeCount` の降順（同数は登録した順）で、上限まで返す */
  const ranking = (): readonly ApiRow[] =>
    activities
      .map((activity, index) => ({ activity, index }))
      .toSorted((a, b) => attendeeCount(b.activity) - attendeeCount(a.activity) || a.index - b.index)
      .slice(0, TOP)
      .map((entry) => activityRow(entry.activity, 0));

  const specBody = (instanceId: string): ApiSpecBody => ({
    instanceId,
    schemaVersion: options.schemaVersion ?? DRAFT_SCHEMA_VERSION,
    sourceSha256: options.sourceSha256,
    spec: FAKE_SPEC,
    permissions: PERMISSIONS,
    actions: FAKE_SPEC.actions,
  });

  const viewBody = (instanceId: string, view: string): ApiViewBody | null => {
    if (view === "activities") {
      const offset = options.breakView === "activities" ? 1 : 0;
      return {
        instanceId,
        view,
        entity: "activity",
        fields: ["kind", "date", "attendees", "cost"],
        computed: ["attendeeCount"],
        permissions: PERMISSIONS,
        actions: FAKE_SPEC.actions.filter((action) => action.entity === "activity"),
        rows: activities.map((activity) => activityRow(activity, offset)),
        groups: { activitiesByKind: byKind() },
      };
    }
    if (view === "dashboard") {
      return {
        instanceId,
        view,
        fields: [],
        computed: [],
        permissions: PERMISSIONS,
        actions: FAKE_SPEC.actions,
        rows: [],
        scope: { activityCount: activities.length, attendeeTotal: 0, averageAttendees: null, averageCost: null },
        groups: { activitiesByKind: byKind() },
        ranking: { topActivities: ranking() },
      };
    }
    if (view === MEMBERS_VIEW) {
      // `breakView` のときは、行を落として「members の一覧に作った人が載っていない」を作る
      return {
        instanceId,
        view,
        entity: "member",
        fields: ["name"],
        computed: [],
        permissions: PERMISSIONS,
        actions: FAKE_SPEC.actions.filter((action) => action.entity === "member"),
        rows: options.breakView === MEMBERS_VIEW ? [] : members.map(memberRow),
      };
    }
    return null;
  };

  const asString = (value: ApiValue | undefined): string => (typeof value === "string" ? value : "");

  const client: MusunestClient = {
    getSpec: async (instanceId) => {
      calls.push({ kind: "getSpec", name: "spec" });
      if (options.unreachable !== undefined) throw new Error(options.unreachable);
      return ok(specBody(instanceId));
    },
    getView: async (instanceId, name) => {
      calls.push({ kind: "getView", name });
      const body = viewBody(instanceId, name);
      return body === null
        ? { ok: false, error: { status: 404, code: "NOT_FOUND", fields: [], validations: [] } }
        : ok(body);
    },
    addRecord: async (_instanceId, name, input) => {
      calls.push({ kind: "add", name });
      if (name === "addMember") {
        const member: FakeMember = { id: nextId("member"), name: asString(input["name"]) };
        members.push(member);
        return ok({
          id: member.id,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          fields: { name: member.name },
          computed: {},
        });
      }
      const kind = asString(input["kind"]);
      const date = asString(input["date"]);
      const cost = typeof input["cost"] === "number" ? input["cost"] : Number.NaN;
      const rawAttendees = input["attendees"];
      const attendees = Array.isArray(rawAttendees) ? rawAttendees.map((item) => String(item)) : [];
      const bad: string[] = [];
      if (!(EXPECTED_KINDS as readonly string[]).includes(kind)) bad.push("kind");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad.push("date");
      const ids = new Set(members.map((member) => member.id));
      if (attendees.length === 0 || attendees.some((id) => !ids.has(id))) bad.push("attendees");
      if (!Number.isFinite(cost)) bad.push("cost");
      if (bad.length > 0) return rejected(bad);
      if (options.failActivity === date) {
        return { ok: false, error: { status: 500, code: "INVALID_RESPONSE", fields: [], validations: [] } };
      }
      const activity: FakeActivity = { id: nextId("activity"), kind, date, attendees, cost };
      activities.push(activity);
      return ok(activityRow(activity, 0));
    },
    deleteRecord: async (_instanceId, name, id) => {
      calls.push({ kind: "delete", name });
      if (name === "deleteActivity") {
        const at = activities.findIndex((activity) => activity.id === id);
        if (at < 0) return { ok: false, error: { status: 404, code: "NOT_FOUND", fields: [], validations: [] } };
        if (options.failDelete === "activity") {
          return { ok: false, error: { status: 500, code: "INVALID_RESPONSE", fields: [], validations: [] } };
        }
        activities.splice(at, 1);
        return ok({ entity: "activity", id, deleted: true as const });
      }
      if (name === "deleteMember") {
        if (activities.some((activity) => activity.attendees.includes(id))) return refInUse();
        const at = members.findIndex((member) => member.id === id);
        if (at < 0) return { ok: false, error: { status: 404, code: "NOT_FOUND", fields: [], validations: [] } };
        if (options.failDelete === "member") {
          return { ok: false, error: { status: 500, code: "INVALID_RESPONSE", fields: [], validations: [] } };
        }
        members.splice(at, 1);
        return ok({ entity: "member", id, deleted: true as const });
      }
      return { ok: false, error: { status: 404, code: "NOT_FOUND", fields: [], validations: [] } };
    },
    setRecord: async () => ({ ok: false, error: { status: 404, code: "NOT_FOUND", fields: [], validations: [] } }),
  };

  return {
    client,
    calls,
    members: () => members,
    activities: () => activities,
    actions: () =>
      calls.filter((call) => call.kind === "add" || call.kind === "delete").map((call) => call.name),
  };
}
