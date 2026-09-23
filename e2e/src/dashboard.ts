// staging に置いた見本（ダッシュボード）を採点する runner（Issue #183）。
//
// host と同じ型付きクライアント（@musunest/sdk）で、staging の host の /api 経路（spec・view・action）を通る。
//
// 確かめるもの:
//   1. 原本（packages/appspec-schema/samples/dashboard/app.spec.yaml）の SHA-256 が、staging の spec 応答の
//      `sourceSha256` と一致し、版が草案の版と一致すること。**違えば、採点も書込もせずに止める**
//   2. **時計に依存しない値だけ**（workspace/mvp/m1/00-open-questions.md Q16・Q17）: 活動の一覧の行
//      （種類・日付・参加した人・費用・`attendeeCount`）、見出しごとの集計（`activitiesByKind`。種類ごとの
//      件数。`enum` の `options` の順）、順位（`topActivities`。`attendeeCount` の降順。同数は登録した順）。
//      **「今月」のアプリ全体の値（`scope`）と、月ごとの集計（`activitiesByMonth`）は時計に依るので、
//      ここでは採点しない**——時計を差し込む unit（data-api の app-api.test.ts）で採点する（Q17）。
//      `scope` は**欄と鍵が在ること**だけを見る（数は見ない）
//   3. どの一覧も `getView` が ok で返すこと（配信側が M1.4 の語彙を読めること）。**参照の候補を出す
//      メンバーの一覧（`members`。Issue #200）も ok で、作った A・B・C がその行に載っていること**
//
// 専用インスタンス（固定 ID）だけを使う。**デモ・窓口のインスタンスには触らない。**
// 片付けは **活動 → メンバー** の順に消す（参照されているメンバーは消せない）。メンバーは見本の一覧
// （`members`）にも載るが、**この runner が自分で作ったものだけを、記録した ID で消す**。
// 前回の失敗で残ったメンバーは、活動から参照されていない限りそのまま残る（採点には効かない）。
// ログに URL・ホスト名・資格情報を出さない。応答の生の本文も出さない。

import type { ApiRow, ApiSpecBody, ApiViewBody, MusunestClient } from "@musunest/sdk";
import { actionNameFor, describeError, errorKind, sha256Hex } from "./warikan.js";

/** 見本の原本の置き場（リポジトリの直下からの相対パス） */
export const SAMPLE_DIRECTORY = "packages/appspec-schema/samples/dashboard";
export const SAMPLE_FILE = `${SAMPLE_DIRECTORY}/app.spec.yaml`;

/** 見本の一覧の名前（宣言が正本で、ここは写し） */
export const DASHBOARD_VIEW = "dashboard";
export const ACTIVITIES_VIEW = "activities";
/** メンバーの一覧（参照の候補。Issue #200） */
export const MEMBERS_VIEW = "members";

/** 使うメンバー（登録した順に A・B・C） */
export const MEMBER_NAMES = ["A", "B", "C"] as const;

/** 種類の並び（`kind` の `options` のキーの順。見出しごとの値の期待値の順でもある） */
export const EXPECTED_KINDS = ["practice", "match", "party"] as const;

/**
 * 作る活動と、時計に依存しない期待値。**時計に依らない値だけ**を採点するので、日付は固定でよい
 * （`within: this_month` の値はここでは見ない）。`attendeeCount` は行ごとの計算の期待値である。
 */
export const EXPECTED_ACTIVITIES: readonly {
  readonly kind: string;
  readonly date: string;
  readonly members: readonly string[];
  readonly cost: number;
  readonly attendeeCount: number;
}[] = [
  { kind: "practice", date: "2026-08-31", members: ["A", "C"], cost: 2000, attendeeCount: 2 },
  { kind: "practice", date: "2026-09-10", members: ["A", "B", "C"], cost: 3000, attendeeCount: 3 },
  { kind: "party", date: "2026-09-12", members: ["A", "B"], cost: 5000, attendeeCount: 2 },
  { kind: "match", date: "2026-09-14", members: ["A"], cost: 2000, attendeeCount: 1 },
  { kind: "practice", date: "2026-10-01", members: ["A", "B"], cost: 1000, attendeeCount: 2 },
];

/** 種類ごとの件数（`options` に書いた順。時計に依存しない） */
export const EXPECTED_BY_KIND: readonly { readonly kind: string; readonly count: number }[] = [
  { kind: "practice", count: 3 },
  { kind: "match", count: 1 },
  { kind: "party", count: 1 },
];

/** 順位の部品の鍵（宣言の `widgets` の `name`） */
export const RANKING_NAME = "topActivities";

/** 順位が返す、行ごとの計算（`attendeeCount`）の並び（降順。同数は登録した順で安定） */
export const EXPECTED_RANKING: readonly number[] = [3, 2, 2, 2, 1];

/** 数値の部品（`scope: app`）が読む計算の名前。**値は時計に依るので採点せず、欄と鍵だけを見る** */
export const SCOPE_NAMES = [
  "activityCount",
  "attendeeTotal",
  "averageAttendees",
  "averageCost",
] as const;

export interface DashboardIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface DashboardDeps extends DashboardIo {
  /** host と同じ型付きクライアント（宛先は呼ぶ側が決める。ここは URL を知らない） */
  readonly client: MusunestClient;
  /** e2e 専用のインスタンスの ID */
  readonly instanceId: string;
  /** 原本（app.spec.yaml）を読んだ文字列。SHA-256 はここから求める */
  readonly source: string;
  /** 期待する版（呼ぶ側が渡す） */
  readonly expectedSchemaVersion: string;
}

export interface DashboardResult {
  /** SHA・値・後片付けのすべてが成功したときだけ true（終了 0 の条件） */
  readonly ok: boolean;
  /** 人が読む理由。**値（URL・ホスト名・資格情報）を含めない** */
  readonly reason: string;
}

const fail = (reason: string): DashboardResult => ({ ok: false, reason });

const rowsOf = async (
  client: MusunestClient,
  instanceId: string,
  view: string,
): Promise<{ readonly ok: true; readonly body: ApiViewBody } | { readonly ok: false; readonly reason: string }> => {
  const result = await client.getView(instanceId, view);
  return result.ok
    ? { ok: true, body: result.value }
    : { ok: false, reason: `一覧（${view}）を読めない（${describeError(result.error)}）` };
};

/** 活動をすべて消す（**メンバーより先**。参照されているメンバーは消せない） */
async function cleanActivities(deps: DashboardDeps, deleteActivity: string): Promise<DashboardResult> {
  const listed = await rowsOf(deps.client, deps.instanceId, ACTIVITIES_VIEW);
  if (!listed.ok) return fail(listed.reason);
  for (const row of listed.body.rows) {
    const deleted = await deps.client.deleteRecord(deps.instanceId, deleteActivity, row.id);
    if (!deleted.ok) return fail(`活動（${row.id}）を消せない（${describeError(deleted.error)}）`);
  }
  return { ok: true, reason: "" };
}

/** 自分で作ったメンバーを、記録した ID で消す（同名のメンバーが前回から残っていても、それには触らない） */
async function deleteMembers(deps: DashboardDeps, deleteMember: string, ids: readonly string[]): Promise<DashboardResult> {
  for (const id of ids) {
    const deleted = await deps.client.deleteRecord(deps.instanceId, deleteMember, id);
    if (!deleted.ok) return fail(`メンバー（${id}）を消せない（${describeError(deleted.error)}）`);
  }
  return { ok: true, reason: "" };
}

/** A・B・C を新しく登録し、名前 → ID の対応を返す。**消すための ID は `ids` に足していく**（途中で失敗しても片付く） */
async function createMembers(
  deps: DashboardDeps,
  addMember: string,
  ids: string[],
): Promise<
  | { readonly ok: true; readonly members: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string }
> {
  const members = new Map<string, string>();
  for (const name of MEMBER_NAMES) {
    const created = await deps.client.addRecord(deps.instanceId, addMember, { name });
    if (!created.ok) return { ok: false, reason: `メンバー（${name}）を登録できない（${describeError(created.error)}）` };
    members.set(name, created.value.id);
    ids.push(created.value.id);
  }
  return { ok: true, members };
}

/** 活動を宣言の順に作る（種類・日付・参加した人・費用は入力で指定する） */
async function createActivities(
  deps: DashboardDeps,
  addActivity: string,
  members: ReadonlyMap<string, string>,
): Promise<DashboardResult> {
  for (const expected of EXPECTED_ACTIVITIES) {
    const attendees: string[] = [];
    for (const name of expected.members) {
      const id = members.get(name);
      if (id === undefined) return fail(`参加者（${name}）の ID を記録できていない`);
      attendees.push(id);
    }
    const created = await deps.client.addRecord(deps.instanceId, addActivity, {
      kind: expected.kind,
      date: expected.date,
      attendees,
      cost: expected.cost,
    });
    if (!created.ok) {
      return fail(`活動（${expected.date}）を登録できない（${describeError(created.error)}）`);
    }
  }
  return { ok: true, reason: "" };
}

/** 宣言（spec 応答）から使う操作の名前を引く */
function actionsOf(
  spec: ApiSpecBody,
  problems: string[],
): { readonly addMember: string; readonly addActivity: string; readonly deleteActivity: string; readonly deleteMember: string } | null {
  const addMember = actionNameFor(spec, "member", "create");
  const addActivity = actionNameFor(spec, "activity", "create");
  const deleteActivity = actionNameFor(spec, "activity", "delete");
  const deleteMember = actionNameFor(spec, "member", "delete");
  if (
    addMember === undefined ||
    addActivity === undefined ||
    deleteActivity === undefined ||
    deleteMember === undefined
  ) {
    problems.push("宣言に、採点と後片付けに要る action が無い（member・activity の create と delete）");
    return null;
  }
  return { addMember, addActivity, deleteActivity, deleteMember };
}

/** 種類の選択肢の並び（`columns` と同じく `options` に書いた順）を見る */
function checkKindOptions(spec: ApiSpecBody, problems: string[]): void {
  const activity = spec.spec.entities.find((entity) => entity.name === "activity");
  const kind = activity?.fields["kind"];
  if (typeof kind !== "object" || kind === null || Array.isArray(kind) || kind.type !== "enum") {
    problems.push("activity の kind が選択肢（enum）でない");
    return;
  }
  const keys = Object.keys(kind.options);
  if (keys.join(",") !== EXPECTED_KINDS.join(",")) {
    problems.push(`kind の選択肢の並びが ${EXPECTED_KINDS.join("・")} でない（${keys.join("・")}）`);
  }
}

/** 活動の一覧の行を、時計に依存しない期待値（種類・日付・参加した人・費用・attendeeCount）と比べる */
function checkActivityRows(
  rows: readonly ApiRow[],
  members: ReadonlyMap<string, string>,
  problems: string[],
): void {
  const nameById = new Map([...members].map(([name, id]) => [id, name]));
  if (rows.length !== EXPECTED_ACTIVITIES.length) {
    problems.push(`活動の一覧の行数が ${EXPECTED_ACTIVITIES.length} でない（${rows.length}）`);
    return;
  }
  EXPECTED_ACTIVITIES.forEach((expected, index) => {
    const row = rows[index];
    if (row === undefined) return;
    if (row.fields["kind"] !== expected.kind) problems.push(`${expected.date} の種類が ${expected.kind} でない`);
    if (row.fields["date"] !== expected.date) problems.push(`${index + 1} 件目の日付が ${expected.date} でない`);
    if (row.fields["cost"] !== expected.cost) problems.push(`${expected.date} の費用が ${expected.cost} でない`);
    const shown = row.fields["attendees"];
    const names = Array.isArray(shown) ? shown.map((id) => nameById.get(String(id)) ?? String(id)) : [];
    if (names.join("・") !== expected.members.join("・")) {
      problems.push(`${expected.date} の参加した人が ${expected.members.join("・")} でない`);
    }
    if (row.computed["attendeeCount"] !== expected.attendeeCount) {
      problems.push(`${expected.date} の attendeeCount が ${expected.attendeeCount} でない`);
    }
  });
}

/** 見出しごとの集計（種類ごとの件数）を比べる（時計に依存しない） */
function checkByKind(
  groups: ApiViewBody["groups"],
  view: string,
  problems: string[],
): void {
  const shown = groups?.["activitiesByKind"] ?? null;
  if (shown === null) {
    problems.push(`一覧（${view}）に見出しごとの集計（activitiesByKind）が無い`);
    return;
  }
  const expected = EXPECTED_BY_KIND.map((entry) => ({ heading: entry.kind, value: entry.count }));
  if (JSON.stringify(shown) !== JSON.stringify(expected)) {
    problems.push(`一覧（${view}）の種類ごとの件数が期待と違う`);
  }
}

/** 順位（`attendeeCount` の降順）を比べる（時計に依存しない） */
function checkRanking(view: ApiViewBody, problems: string[]): void {
  const rows = view.ranking?.[RANKING_NAME] ?? null;
  if (rows === null) {
    problems.push(`ダッシュボードに順位（${RANKING_NAME}）が無い`);
    return;
  }
  const values = rows.map((row) => row.computed["attendeeCount"]);
  if (JSON.stringify(values) !== JSON.stringify(EXPECTED_RANKING)) {
    problems.push(`順位（${RANKING_NAME}）の並びが期待と違う`);
  }
}

/** メンバーの一覧（`members`）に、作った A・B・C が載っていることを見る（参照の候補を出す view） */
function checkMembers(
  rows: readonly ApiRow[],
  members: ReadonlyMap<string, string>,
  problems: string[],
): void {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.fields["name"];
    if (typeof name === "string") names.add(name);
  }
  for (const name of members.keys()) {
    if (!names.has(name)) problems.push(`メンバーの一覧（${MEMBERS_VIEW}）に ${name} の行が無い`);
  }
}

/** 時計に依存しない値を、API の値として比べる。問題があればその理由を返す */
async function score(
  deps: DashboardDeps,
  spec: ApiSpecBody,
  members: ReadonlyMap<string, string>,
): Promise<DashboardResult> {
  const problems: string[] = [];
  checkKindOptions(spec, problems);

  const activities = await rowsOf(deps.client, deps.instanceId, ACTIVITIES_VIEW);
  if (!activities.ok) return fail(activities.reason);
  checkActivityRows(activities.body.rows, members, problems);
  checkByKind(activities.body.groups, ACTIVITIES_VIEW, problems);

  const dashboard = await rowsOf(deps.client, deps.instanceId, DASHBOARD_VIEW);
  if (!dashboard.ok) return fail(dashboard.reason);
  // **行を並べない**（`rows` は空）。部品が読む値は `scope`・`groups`・`ranking` に載る
  if (dashboard.body.rows.length !== 0) problems.push("ダッシュボードの一覧が行を返している");
  // `scope` の**欄と鍵**だけを見る（今月の値は時計に依るので採点しない。Q17）
  const scopeKeys = Object.keys(dashboard.body.scope ?? {}).sort();
  if (scopeKeys.join(",") !== [...SCOPE_NAMES].sort().join(",")) {
    problems.push("ダッシュボードの scope の鍵が期待と違う");
  }
  checkByKind(dashboard.body.groups, DASHBOARD_VIEW, problems);
  checkRanking(dashboard.body, problems);

  const memberList = await rowsOf(deps.client, deps.instanceId, MEMBERS_VIEW);
  if (!memberList.ok) return fail(memberList.reason);
  checkMembers(memberList.body.rows, members, problems);

  return problems.length > 0 ? fail(problems.join(" / ")) : { ok: true, reason: "" };
}

/**
 * staging の専用インスタンスで、宣言の照合 → 後片付け → 作る → 採点 → 後片付け を 1 周する。
 *
 * 順は「宣言と原本 SHA の照合 →（前回の活動を片付ける）→ メンバーと活動を作る → 採点 →
 * 片付ける（活動 → メンバー）」である。**照合に通らない間は 1 つも書かない。**
 */
export async function runDashboard(deps: DashboardDeps): Promise<DashboardResult> {
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

  let result: DashboardResult = fail("採点に到達しなかった");
  const memberIds: string[] = [];
  try {
    // 3. 前回の活動を片付ける（専用インスタンスの活動は、すべてこの e2e のもの）
    const before = await cleanActivities(deps, actions.deleteActivity);
    if (!before.ok) {
      result = fail(`開始時の片付けに失敗した（${before.reason}）`);
    } else {
      out("e2e: 前回までの活動（あれば）を片付けた");

      // 4. メンバー A・B・C を新しく作る（採点で、members の一覧に載っていることを確かめる）
      const created = await createMembers(deps, actions.addMember, memberIds);
      if (!created.ok) {
        result = fail(created.reason);
      } else {
        // 5. 活動を作る
        const activities = await createActivities(deps, actions.addActivity, created.members);
        if (!activities.ok) {
          result = activities;
        } else {
          out(`e2e: メンバー ${MEMBER_NAMES.join("・")} と活動（${EXPECTED_ACTIVITIES.length} 件）をそろえた`);

          // 6. 採点（時計に依存しない値だけ）
          result = await score(deps, spec.value, created.members);
          if (result.ok) out("e2e: 採点した（メンバーの一覧・活動の行・種類ごとの件数・順位）");
        }
      }
    }
  } catch (e) {
    result = fail(`予期しない失敗（${errorKind(e)}）`);
  }

  // 7. 後片付け（失敗しても必ず行う）。**ここが失敗したら成功にしない**（活動 → メンバーの順）
  const after = await cleanActivities(deps, actions.deleteActivity);
  if (!after.ok) {
    return fail(result.reason === "" ? `後片付けに失敗した（${after.reason}）` : `${result.reason} / 後片付けにも失敗した（${after.reason}）`);
  }
  const members = await deleteMembers(deps, actions.deleteMember, memberIds);
  if (!members.ok) {
    return fail(result.reason === "" ? `後片付けに失敗した（${members.reason}）` : `${result.reason} / 後片付けにも失敗した（${members.reason}）`);
  }
  out("e2e: 専用データを片付けた（活動 → メンバーの順）");
  return result;
}
