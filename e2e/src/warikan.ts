// staging に置いた見本（割り勘）を採点する runner（Issue #110）。
//
// host と同じ型付きクライアント（@musunest/sdk）で、staging の host の /api 経路（spec・view・action）を通る。
// M1a の判定 1・5 のうち、M1.2（割り勘）で確かめられる部分を担う。
//
// 確かめるもの（workspace/mvp/m1/00-open-questions.md Q16・Q17）:
//   1. 原本（packages/appspec-schema/samples/warikan/app.spec.yaml）の SHA-256 が、staging の spec 応答の
//      `sourceSha256` と一致し、版が草案の版と一致すること。**違えば、採点も後片付けも書込もせずに止める**
//      （食い違った原本のままデータを書かない）
//   2. 時計に依存しない採点の値（workspace/mvp/m1/02-l2-spec-examples.md §2.3）: 支出の shareAmount、
//      メンバーの paid / owed / balance、精算（settle）の送金の並び。**時計は上書きしない**——
//      ログインの無い API に時刻を変える入口を作らない（Q17）
//
// 専用インスタンス（固定 ID）だけを使う。デモ・窓口のインスタンス（m11-demo-…・m12-demo-…）には触らない。
// 片付けは #109 の通常の削除 action で行い、**支出 → メンバー** の順に消す——逆にすると、支出から
// 参照されているメンバーは消せず（409 REFERENCE_IN_USE）、専用データが残る。
//
// ログに URL・ホスト名・資格情報を出さない。応答の生の本文も出さない（SDK が型にした値だけを見る）。
// 例外の文言は呼ぶ側（cli.ts）が捨て、種別だけを出す。

import type { ApiRow, ClientError, MusunestClient } from "@musunest/sdk";

/** 見本の原本の置き場（リポジトリの直下からの相対パス） */
export const SAMPLE_DIRECTORY = "packages/appspec-schema/samples/warikan";
export const SAMPLE_FILE = `${SAMPLE_DIRECTORY}/app.spec.yaml`;

/** 見本の一覧の名前（packages/appspec-schema/samples/warikan/app.spec.yaml）。宣言が正本で、ここは写し */
export const MEMBER_VIEW = "memberList";
export const EXPENSE_VIEW = "expenseList";
export const SETTLEMENT_VIEW = "settlement";

/**
 * 照合する版（草案）。正本は appspec-schema の `APPSPEC_SCHEMA_VERSION`
 * （e2e が参照できる workspace の依存は sdk だけ。CLAUDE.md「依存の向き」）。版が上がればここも直す。
 */
export const DRAFT_SCHEMA_VERSION = "community.app-spec/v0.2-draft";

/** 作るメンバー（`bind` に当たるもの）。登録した順に A・B・C */
export const MEMBER_NAMES = ["A", "B", "C"] as const;

/** 作る支出と、採点の期待値（02 §2.3）。**入力と期待値を1か所に持つ**（ずれないように） */
export const EXPECTED_EXPENSES: readonly {
  readonly description: string;
  readonly payer: string;
  readonly amount: number;
  readonly shareAmount: number;
}[] = [
  { description: "夕食", payer: "A", amount: 6000, shareAmount: 2000 },
  { description: "タクシー", payer: "B", amount: 3000, shareAmount: 1000 },
];

/** メンバーごとの期待値（paid / owed / balance。02 §2.3） */
export const EXPECTED_MEMBERS: readonly {
  readonly name: string;
  readonly paid: number;
  readonly owed: number;
  readonly balance: number;
}[] = [
  { name: "A", paid: 6000, owed: 3000, balance: 3000 },
  { name: "B", paid: 3000, owed: 3000, balance: 0 },
  { name: "C", paid: 0, owed: 3000, balance: -3000 },
];

/** 精算の期待値（送金元・送金先はメンバーの名前。02 §2.3）。**1 件だけ**である */
export const EXPECTED_SETTLEMENT: readonly {
  readonly fromName: string;
  readonly toName: string;
  readonly amount: number;
}[] = [{ fromName: "C", toName: "A", amount: 3000 }];

/**
 * 文字列の UTF-8 バイト列の SHA-256（小文字の 16 進 64 桁）。
 * 原本の SHA の求め方の正本は spec-engine の `sha256Hex`（publish と同じ値になる）。
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface WarikanIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface WarikanDeps extends WarikanIo {
  /** host と同じ型付きクライアント（宛先は呼ぶ側が決める。ここは URL を知らない） */
  readonly client: MusunestClient;
  /** e2e 専用のインスタンスの ID */
  readonly instanceId: string;
  /** 原本（app.spec.yaml）を読んだ文字列。SHA-256 はここから求める */
  readonly source: string;
  /** 期待する版（呼ぶ側が渡す。既定は草案の版） */
  readonly expectedSchemaVersion: string;
}

export interface WarikanResult {
  /** SHA・値・後片付けのすべてが成功したときだけ true（終了 0 の条件） */
  readonly ok: boolean;
  /** 人が読む理由。**値（URL・ホスト名・資格情報）を含めない** */
  readonly reason: string;
}

/** 失敗の理由。値を持たない説明だけを組み立てる */
const fail = (reason: string): WarikanResult => ({ ok: false, reason });

/** 例外の種別だけを返す（文言は URL・ホスト名・資格情報を含み得るので出さない）。 */
export function errorKind(e: unknown): string {
  if (e instanceof Error && /^\w+$/.test(e.name)) return e.name;
  return typeof e;
}

/** SDK の失敗を、値を持たない説明にする（誤りコード・HTTP ステータス・宣言の名前だけ）。 */
export function describeError(error: ClientError): string {
  const parts: string[] = [error.code];
  if (error.status !== null) parts.push(`HTTP ${error.status}`);
  if (error.fields.length > 0) parts.push(`fields=${error.fields.join(",")}`);
  if (error.validations.length > 0) parts.push(`validations=${error.validations.join(",")}`);
  return parts.join(" ");
}

/** 宣言（spec 応答）から、entity と種類（kind）に当たる action の名前を引く。無ければ undefined */
export function actionNameFor(spec: { readonly actions: readonly { readonly name: string; readonly entity: string; readonly kind?: string }[] }, entity: string, kind: "create" | "delete"): string | undefined {
  return spec.actions.find((action) => action.entity === entity && (action.kind ?? "create") === kind)?.name;
}

/**
 * 専用データを片付ける。**支出 → メンバー** の順に消す（参照されているメンバーを先に消すと 409 で残る）。
 * 一覧を読み、行を1件ずつ消す。消せない行があれば失敗を返す（成功にしない）。
 */
async function cleanUp(deps: WarikanDeps, deleteExpense: string, deleteMember: string): Promise<WarikanResult> {
  const { client, instanceId } = deps;
  const expenses = await client.getView(instanceId, EXPENSE_VIEW);
  if (!expenses.ok) return fail(`一覧（${EXPENSE_VIEW}）を読めない（${describeError(expenses.error)}）`);
  for (const row of expenses.value.rows) {
    const deleted = await client.deleteRecord(instanceId, deleteExpense, row.id);
    if (!deleted.ok) return fail(`支出（${row.id}）を消せない（${describeError(deleted.error)}）`);
  }
  const members = await client.getView(instanceId, MEMBER_VIEW);
  if (!members.ok) return fail(`一覧（${MEMBER_VIEW}）を読めない（${describeError(members.error)}）`);
  for (const row of members.value.rows) {
    const deleted = await client.deleteRecord(instanceId, deleteMember, row.id);
    if (!deleted.ok) return fail(`メンバー（${row.id}）を消せない（${describeError(deleted.error)}）`);
  }
  return { ok: true, reason: "" };
}

interface Created {
  readonly members: readonly { readonly name: string; readonly id: string }[];
  readonly expenses: readonly { readonly description: string; readonly id: string }[];
}

/** A/B/C と、夕食・タクシーを作る。**動的な ID は登録結果から記録する** */
async function createScenario(deps: WarikanDeps, addMember: string, addExpense: string): Promise<WarikanResult | Created> {
  const { client, instanceId } = deps;
  const members: { name: string; id: string }[] = [];
  for (const name of MEMBER_NAMES) {
    const created = await client.addRecord(instanceId, addMember, { name });
    if (!created.ok) return fail(`メンバー（${name}）を登録できない（${describeError(created.error)}）`);
    members.push({ name, id: created.value.id });
  }
  const participants = members.map((member) => member.id);
  const expenses: { description: string; id: string }[] = [];
  for (const expected of EXPECTED_EXPENSES) {
    const payer = members.find((member) => member.name === expected.payer);
    if (payer === undefined) return fail(`払った人（${expected.payer}）の ID を記録できていない`);
    const created = await client.addRecord(instanceId, addExpense, {
      description: expected.description,
      amount: expected.amount,
      payer: payer.id,
      participants,
    });
    if (!created.ok) return fail(`支出（${expected.description}）を登録できない（${describeError(created.error)}）`);
    expenses.push({ description: expected.description, id: created.value.id });
  }
  return { members, expenses };
}

const isCreated = (value: WarikanResult | Created): value is Created => "members" in value;

/** 一覧の行から計算の値を読む（求められなかった計算は `null` なので、数でなければ undefined） */
const computedOf = (row: ApiRow, name: string): number | undefined => {
  const value = row.computed[name];
  return typeof value === "number" ? value : undefined;
};

/**
 * 時計に依存しない採点の値（02 §2.3）を、API の値として比べる。
 * 支出の shareAmount、メンバーの paid / owed / balance、精算（settle）の送金の並び。
 */
async function score(deps: WarikanDeps, created: Created): Promise<WarikanResult> {
  const { client, instanceId } = deps;
  const problems: string[] = [];

  const expenses = await client.getView(instanceId, EXPENSE_VIEW);
  if (!expenses.ok) return fail(`一覧（${EXPENSE_VIEW}）を読めない（${describeError(expenses.error)}）`);
  if (expenses.value.rows.length !== EXPECTED_EXPENSES.length) {
    problems.push(`支出の行数が ${EXPECTED_EXPENSES.length} でない（${expenses.value.rows.length}）`);
  }
  for (const expected of EXPECTED_EXPENSES) {
    const row = expenses.value.rows.find((candidate) => candidate.fields["description"] === expected.description);
    if (row === undefined) {
      problems.push(`支出（${expected.description}）の行が無い`);
      continue;
    }
    if (row.fields["amount"] !== expected.amount) {
      problems.push(`支出（${expected.description}）の amount が ${expected.amount} でない`);
    }
    if (computedOf(row, "shareAmount") !== expected.shareAmount) {
      problems.push(`支出（${expected.description}）の shareAmount が ${expected.shareAmount} でない`);
    }
  }

  const members = await client.getView(instanceId, MEMBER_VIEW);
  if (!members.ok) return fail(`一覧（${MEMBER_VIEW}）を読めない（${describeError(members.error)}）`);
  if (members.value.rows.length !== EXPECTED_MEMBERS.length) {
    problems.push(`メンバーの行数が ${EXPECTED_MEMBERS.length} でない（${members.value.rows.length}）`);
  }
  const idByName = new Map(created.members.map((member) => [member.id, member.name]));
  for (const expected of EXPECTED_MEMBERS) {
    const row = members.value.rows.find((candidate) => candidate.fields["name"] === expected.name);
    if (row === undefined) {
      problems.push(`メンバー（${expected.name}）の行が無い`);
      continue;
    }
    for (const name of ["paid", "owed", "balance"] as const) {
      if (computedOf(row, name) !== expected[name]) {
        problems.push(`メンバー（${expected.name}）の ${name} が ${expected[name]} でない`);
      }
    }
  }

  const settlement = await client.getView(instanceId, SETTLEMENT_VIEW);
  if (!settlement.ok) return fail(`一覧（${SETTLEMENT_VIEW}）を読めない（${describeError(settlement.error)}）`);
  const transfers = settlement.value.settlement;
  if (transfers === undefined || transfers === null) {
    problems.push("精算（settlement）が返らない");
  } else if (transfers.length !== EXPECTED_SETTLEMENT.length) {
    problems.push(`精算が ${transfers.length} 件（${EXPECTED_SETTLEMENT.length} 件だけのはず）`);
  } else {
    for (const expected of EXPECTED_SETTLEMENT) {
      const shown = transfers.find(
        (transfer) => idByName.get(transfer.from) === expected.fromName && idByName.get(transfer.to) === expected.toName,
      );
      if (shown === undefined) problems.push(`精算（${expected.fromName}→${expected.toName}）が無い`);
      else if (shown.amount !== expected.amount) problems.push(`精算（${expected.fromName}→${expected.toName}）の額が ${expected.amount} でない`);
    }
  }

  if (problems.length > 0) return fail(problems.join(" / "));
  return { ok: true, reason: "" };
}

/**
 * staging の専用インスタンスで、宣言の照合 → 採点 → 後片付け を1周する。
 *
 * 順は「宣言と原本 SHA の照合 →（前回の失敗の残りを片付ける）→ 作る → 採点 → 片付ける」である。
 * **照合に通らない間は1つも書かない。** 途中で失敗しても、作ったもの（と残っていたもの）は最後に必ず片付ける。
 */
export async function runWarikan(deps: WarikanDeps): Promise<WarikanResult> {
  const { client, instanceId, out } = deps;

  // 1. 宣言を読む（読み取りだけ。まだ1つも書かない）
  const spec = await client.getSpec(instanceId);
  if (!spec.ok) return fail(`宣言を読めない（${describeError(spec.error)}）`);

  // 2. 原本 SHA-256 と版の照合。**違えば採点も後片付けも書込もしない**
  const expectedSha = await sha256Hex(deps.source);
  if (spec.value.sourceSha256 !== expectedSha) {
    return fail(`原本 SHA-256 が staging の宣言と一致しない（staging の見本がリポジトリと違う）`);
  }
  if (spec.value.schemaVersion !== deps.expectedSchemaVersion) {
    return fail(`版が草案の版と一致しない（期待 ${deps.expectedSchemaVersion}）`);
  }
  out(`e2e: 原本 SHA-256 と版（${spec.value.schemaVersion}）が一致した`);

  // 行動名は宣言から引く（宣言が変われば追随する）
  const addMember = actionNameFor(spec.value, "member", "create");
  const addExpense = actionNameFor(spec.value, "expense", "create");
  const deleteMember = actionNameFor(spec.value, "member", "delete");
  const deleteExpense = actionNameFor(spec.value, "expense", "delete");
  if (addMember === undefined || addExpense === undefined || deleteExpense === undefined || deleteMember === undefined) {
    return fail("宣言に、採点と後片付けに要る action が無い（member・expense の create と delete）");
  }

  let result: WarikanResult = fail("採点に到達しなかった");
  try {
    // 3. 前回の失敗の残りを片付ける（専用インスタンスのデータは、すべてこの e2e のもの）
    const before = await cleanUp(deps, deleteExpense, deleteMember);
    if (!before.ok) {
      result = fail(`開始時の片付けに失敗した（${before.reason}）`);
    } else {
      out("e2e: 前回までの専用データ（あれば）を片付けた");

      // 4. 作る
      const created = await createScenario(deps, addMember, addExpense);
      if (!isCreated(created)) {
        result = created;
      } else {
        out(`e2e: メンバー ${MEMBER_NAMES.join("・")} と支出（${EXPECTED_EXPENSES.map((e) => e.description).join("・")}）を作った`);

        // 5. 採点（時計に依存しない値だけ）
        result = await score(deps, created);
        if (result.ok) out("e2e: 採点した（shareAmount・paid/owed/balance・精算）");
      }
    }
  } catch (e) {
    result = fail(`予期しない失敗（${errorKind(e)}）`);
  }

  // 6. 後片付け（失敗しても必ず行う）。**ここが失敗したら成功にしない**
  const after = await cleanUp(deps, deleteExpense, deleteMember);
  if (!after.ok) {
    return fail(result.reason === "" ? `後片付けに失敗した（${after.reason}）` : `${result.reason} / 後片付けにも失敗した（${after.reason}）`);
  }
  out("e2e: 専用データを片付けた（支出 → メンバーの順）");
  return result;
}
