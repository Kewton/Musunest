// Instant Renderer — 宣言から、一覧と追加フォームをその場で描く画面（Issue #104。参照と文言は #106、
// 表（`type: table`）と精算の表示（`type: settlement`）は #142）。
//
// **画面は式を評価しない。** 計算値も「操作してよいか」も data-api が返したものをそのまま見せる
// （workspace/mvp/m1/README.md §4「計算はサーバ側」）。だからこの画面が決めるのは、次の5つだけである。
//   1. どの状態を描くか — 読込中・空一覧・未存在（404）・権限不足（403）・通信失敗を区別する
//   2. 一覧の並べ方 — 項目を宣言の順、続いて計算を宣言の順。表が `show` を持てば、**その順**である
//      （M1.2。docs/semantics.md「table」）。行は API が返した順（登録順）のまま
//   3. どの部品で描くか — 宣言の `type` が `settlement` なら精算の表示、ほかは表（M1.2）
//   4. 追加フォームを出すか — view が返した `permissions.write` と、その entity の action の有無だけで決める
//   5. 参照（`ref`・参照 list）の見せ方 — **候補は参照先の一覧から取り、送るのは ID、見せるのは名前**である
//   6. 選択肢（`enum`）の見せ方 — **宣言の `options` をそのまま選択肢にし、送るのはキー、見せるのは表示名**である（M1.3）
//   7. 行ごとのボタンを出すか — **API が返した `row.allowedActions` をそのまま見る**（M1.3）。
//      **画面は `when` の式を評価しない**し、隠すことは守りでもない——断るのは data-api である（`03` §2.2）
//
// **参照の候補は、参照先の entity の一覧（view）から取る。** 宣言が参照先の一覧を持たなければ候補は 0 件で、
// 画面は架空の ID を作らない（フォームは「先に登録してください」と出す。守りはサーバ側）。
//
// **インスタンス固有のデータはビルド済みの HTML に埋めない。** この component はブラウザでだけ動き、
// データは同じ origin の `/api/*`（host の Worker が gateway へ中継する。Issue #103）から取る。
// 利用者の入力は React の text node として挿入する（HTML として解釈させない）。

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  Action,
  ApiActionRef,
  ApiRow,
  ApiSpecBody,
  ApiValue,
  ApiViewBody,
  AppSpec,
  ClientError,
  ClientResult,
  Entity,
  MusunestClient,
} from "@musunest/sdk";
import { displayNameOf, fieldKind, fieldTarget, updateRecord } from "@musunest/sdk";
import { AddForm } from "./form";
import type { AddFormResult, FormField, FormOption } from "./form";
import { SettlementList } from "./settlement";
import { Board } from "./board";
import { ListScreen } from "./list";
import { Dashboard } from "./dashboard";
import type { FilterField } from "./list";
import "./renderer.css";

/** 読めなかった理由。**状態を1つに潰さない**（未存在・権限不足・通信失敗を区別して描く） */
export type FailureReason = "notFound" | "forbidden" | "network";

/** 参照先の候補（参照の項目に渡す。Issue #106） */
export interface ReferenceData {
  readonly entity: string;
  /** 画面に出す名前の項目。参照先に文字列の項目が無ければ `null`（そのときは ID を出す） */
  readonly labelField: string | null;
  readonly rows: readonly ApiRow[];
}

type ScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: FailureReason }
  | {
      readonly kind: "ready";
      readonly spec: ApiSpecBody;
      readonly view: ApiViewBody | null;
      readonly references: readonly ReferenceData[];
    };

export interface InstantRendererProps {
  readonly instanceId: string;
  readonly client: MusunestClient;
}

const FAILURE_MESSAGES: Readonly<Record<FailureReason, string>> = {
  notFound: "アプリが見つかりません",
  forbidden: "このアプリを表示する権限がありません",
  network: "通信に失敗しました",
};

export function InstantRenderer({ instanceId, client }: InstantRendererProps) {
  const [state, setState] = useState<ScreenState>({ kind: "loading" });
  /**
   * 操作が断られた理由（消す（M1.2）と、決まった値への書き換え（M1.3））。
   * **画面の非表示だけに頼らず、サーバの答えを出す**（`data-state` で 2 つを区別する）。
   */
  const [actionFailure, setActionFailure] = useState<{
    readonly state: string;
    readonly message: string;
  } | null>(null);
  /**
   * いま「直す」を開いている行（`set` を持たない `kind: update`。M1.5。Issue #215）。
   * **状態はここだけが持つ**——どの部品（表・一覧・ボード）から開いても、フォームはこの 1 つである。
   * 開いていなければ `null` である。
   */
  const [editing, setEditing] = useState<{ readonly action: string; readonly id: string } | null>(null);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    void (async () => {
      const spec = await client.getSpec(instanceId);
      if (!active) return;
      if (!spec.ok) {
        setState(failed(spec.error));
        return;
      }
      const first = spec.value.spec.views[0];
      const next =
        first === undefined
          ? { kind: "ready" as const, spec: spec.value, view: null, references: [] }
          : await loadView(client, instanceId, spec.value, first.name);
      if (!active) return;
      setState(next);
    })();
    return () => {
      active = false;
    };
  }, [client, instanceId]);

  if (state.kind === "loading") {
    return (
      <p className="state loading" data-state="loading" role="status">
        読み込み中…
      </p>
    );
  }

  if (state.kind === "failed") {
    return (
      <p className="state failure" data-state={state.reason} role="alert">
        {FAILURE_MESSAGES[state.reason]}
      </p>
    );
  }

  const { spec, view, references } = state;
  const action = view === null ? undefined : addActionOf(spec, view);
  // 消す操作（`kind: delete`。M1.2）。宣言が無ければ削除ボタンも出さない
  const deleteAction = view === null ? undefined : deleteActionOf(spec, view);
  // 行ごとの消すボタン（参照されている行には理由。Issue #214）。**table・list・board が同じ処理を通る**
  // ——3 つの部品は、この 1 つの関数を受け取って呼ぶだけである（`deleteControl` を部品ごとに書かない）
  const renderDelete: RowDeleteControl | undefined =
    deleteAction === undefined
      ? undefined
      : (row) => deleteControl(row, deleteAction, (id) => void removeRecord(deleteAction.name, id));
  // 決まった値への書き換え（`set` を持つ `kind: update`。M1.3）。宣言の順に、行ごとのボタンにする
  const setActions = view === null ? [] : setActionsOf(spec, view);
  // 直す（`set` を持たない `kind: update`。M1.5。Issue #215）。宣言の順に、行ごとのボタンにする
  const editActions = view === null ? [] : editActionsOf(spec, view);
  // 行ごとの「直す」（Issue #215）。**table・list・board が同じ処理を通る**——3 つの部品は、この
  // 1 つの関数を受け取って呼ぶだけである（`editControl` を部品ごとに書かない。`deleteControl` と同じ）
  const renderEdit: RowEditControl | undefined =
    editActions.length === 0 ? undefined : (row) => editControl(row, editActions, openEdit);
  // 一覧の種類（`type`）と、表に出す名前の順（`show`）は**宣言**にある。API の応答には行だけがある
  const declaration = view === null ? undefined : spec.spec.views.find((item) => item.name === view.view);
  const entity = view === null ? undefined : spec.spec.entities.find((item) => item.name === view.entity);
  // いま「直す」を開いている行。**応答から引く**——読み直しで消えていれば、フォームを出さない
  const editingRow =
    view === null || editing === null ? undefined : view.rows.find((row) => row.id === editing.id);

  /** 一覧の切替。読めなければ同じ理由の画面に落とす（読めなかったことは隠さない） */
  async function showView(name: string): Promise<void> {
    setState(await loadView(client, instanceId, spec, name));
  }

  /** 追加。成功したら**一覧を読み直す**（返ってきた行を勝手に足さない）。失敗は入力欄に返す */
  async function addRecord(values: Readonly<Record<string, ApiValue>>): Promise<AddFormResult> {
    if (view === null || action === undefined) return { ok: false };
    const created = await client.addRecord(instanceId, action.name, values);
    if (!created.ok) {
      return {
        ok: false,
        fields: created.error.fields,
        validations: created.error.validations,
        ...(created.error.validationMessages === undefined
          ? {}
          : { validationMessages: created.error.validationMessages }),
      };
    }
    const refreshed = await loadView(client, instanceId, spec, view.view);
    setState(refreshed);
    return { ok: true };
  }

  /**
   * 消す（M1.2）。成功したら**一覧を読み直す**。断られた理由（参照されている・権限・通信）は
   * その場に出す——**画面の非表示は守りではない**ので、サーバの答えをそのまま見せる（`03` §2.2）。
   */
  async function removeRecord(actionName: string, id: string): Promise<void> {
    if (view === null) return;
    setActionFailure(null);
    const deleted = await client.deleteRecord(instanceId, actionName, id);
    if (!deleted.ok) {
      setActionFailure({ state: "delete-failed", message: reasonOfFailure(deleted.error) });
      return;
    }
    setState(await loadView(client, instanceId, spec, view.view));
  }

  /**
   * 決まった値への書き換え（M1.3）。送るのは**対象の行の ID だけ**である（何を書くかは宣言が持つ）。
   * 成功したら**一覧を読み直す**。断られた理由（条件が成り立たない・権限・通信）はその場に出す
   * ——**画面がボタンを隠すのは親切であって守りではない**ので、サーバの答えをそのまま見せる。
   */
  async function runSetAction(actionName: string, id: string): Promise<void> {
    if (view === null) return;
    setActionFailure(null);
    const applied = await client.setRecord(instanceId, actionName, id);
    if (!applied.ok) {
      setActionFailure({
        state: "action-failed",
        message: reasonOfActionFailure(applied.error, actionName),
      });
      return;
    }
    setState(await loadView(client, instanceId, spec, view.view));
  }

  /**
   * 「直す」を開く（`set` を持たない `kind: update`。M1.5。Issue #215）。**今の行を選ぶだけ**である
   * ——値をフォームへ写すのは `AddForm`（`initial`）で、ここはどの行を開くかしか決めない。
   * 直前の断り（別の操作の）は消す。
   */
  function openEdit(actionName: string, id: string): void {
    setActionFailure(null);
    setEditing({ action: actionName, id });
  }

  /**
   * 直す（`set` を持たない `kind: update`。M1.5。Issue #215）。送るのは**対象の行の ID と、入力した
   * 項目の全部**である（宣言の `set` ではなく、利用者が入れた値で置き換える。docs/semantics.md「update」）。
   * 成功したら**一覧を読み直して**フォームを閉じる。断られた理由はその場に出す（**追加と同じ**）。
   */
  async function editRecord(
    actionName: string,
    id: string,
    values: Readonly<Record<string, ApiValue>>,
  ): Promise<AddFormResult> {
    if (view === null) return { ok: false };
    setActionFailure(null);
    const updated = await updateRecord(client, instanceId, actionName, id, values);
    if (!updated.ok) {
      // 入力の断り（422）は、追加と同じく**フォームに返す**（項目名・検査名・文言）。
      // 条件（`when`）や権限などの断りは、サーバの答えをその場に出す（**画面の非表示だけを守りにしない**）
      if (updated.error.code !== "INPUT_REJECTED") {
        setActionFailure({ state: "edit-failed", message: reasonOfActionFailure(updated.error, actionName) });
        return { ok: false };
      }
      return {
        ok: false,
        fields: updated.error.fields,
        validations: updated.error.validations,
        ...(updated.error.validationMessages === undefined
          ? {}
          : { validationMessages: updated.error.validationMessages }),
      };
    }
    setEditing(null);
    setState(await loadView(client, instanceId, spec, view.view));
    return { ok: true };
  }

  return (
    <main className="instant-renderer" data-state="ready">
      <h1 className="title">{instanceId}</h1>
      {spec.spec.views.length > 1 && (
        <nav className="views" aria-label="一覧の切替">
          {spec.spec.views.map((item) => (
            <button
              key={item.name}
              type="button"
              aria-pressed={view?.view === item.name}
              onClick={() => void showView(item.name)}
            >
              {item.name}
            </button>
          ))}
        </nav>
      )}
      {view !== null && view.scope !== undefined && declaration?.type !== "dashboard" && (
        // アプリ全体の集計（`scope: app`。M1.4。Issue #177）。**API が求めた値をそのまま見せる**
        // （画面は式も集計も評価しない）。求められなかった値（`null`）は「—」で見せ、0 と区別する。
        // **ダッシュボードでは出さない**——部品（`widgets`）が単位つきで同じ値を出す（M1.4。Issue #180）
        <dl className="scope-values" data-scope="true" aria-label="アプリ全体の集計">
          {Object.entries(view.scope).map(([name, value]) => (
            <div className="scope-value" key={name} data-scope-name={name}>
              <dt>{name}</dt>
              <dd>{computedText(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {view !== null && view.groups !== undefined && declaration?.type !== "dashboard" && (
        // 見出しごとの集計（`groupBy`。M1.4。Issue #179）。**API が求めた値をそのまま見せる**
        // （画面は式も集計も評価しない）。求められなかった組（`null`）は「—」で見せ、空の並びと区別する。
        // `enum` の見出しは、宣言の `options` の表示名に写す（月は `YYYY-MM` のまま出す）
        // **ダッシュボードでは出さない**——棒（`bar`）・円（`pie`）の部品が同じ値を見せる（M1.4。Issue #181）
        <section className="group-values" data-groups="true" aria-label="見出しごとの集計">
          {Object.entries(view.groups).map(([name, entries]) => (
            <div className="group" key={name} data-group-name={name}>
              <h2 className="group-title">{displayNameOf(view.labels, name)}</h2>
              {entries === null ? (
                <p className="state group-unavailable" data-state="groupsUnavailable">
                  —
                </p>
              ) : (
                <ul className="group-list">
                  {entries.map((entry) => (
                    <li className="group-entry" key={entry.heading} data-heading={entry.heading}>
                      <span className="group-heading">
                        {groupHeadingOf(spec.spec, name, entry.heading)}
                      </span>
                      <span className="group-number">{computedText(entry.value)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}
      {view === null ? (
        <p className="state" data-state="noview">
          表示できる一覧がありません
        </p>
      ) : declaration?.type === "dashboard" ? (
        // ダッシュボード（M1.4。Issue #180）。**行を並べない**——部品（`widgets`）が指す計算の値を
        // `scope`（数値の部品）と `groups`（棒・円の部品。Issue #181）からそのまま見せる
        // （画面は式も集計も評価しない）。単位と「—」（`null`）は部品が決める。
        // `enum` の見出しは、宣言の `options` の表示名に写す（`groupHeadingOf`。棒・円の凡例にも使う）
        <Dashboard
          view={view}
          parts={declaration.widgets ?? []}
          headingOf={(groupName, heading) => groupHeadingOf(spec.spec, groupName, heading)}
          // 順位の部品は**別の entity の行**を並べる。その行の見出しと選択肢の表示名は、手元の宣言
          // （`getSpec`）から引く——ダッシュボードの応答には `labels` が載らないからである（M1.4。Issue #204）。
          // 値の写し方は、一覧・ボード・表と同じ `displayOf` を通す（部品の中に写し方を持たない）
          itemLabelOf={(entityName, item) => displayNameOf(entityLabelsOf(spec.spec, entityName), item)}
          valueLabelOf={(entityName, field, value) =>
            displayOf(
              spec.spec.entities.find((candidate) => candidate.name === entityName),
              references,
              field,
              value,
            )}
        />
      ) : declaration?.type === "settlement" ? (
        // 精算の表示（M1.2）。**画面は計算しない**——API が返した送金の並びを、名前に対応づけて見せる。
        // `settlement` が無い（宣言が無い）ときも `null` として渡し、空の並びに読み替えない
        <SettlementList
          transfers={view.settlement ?? null}
          rows={view.rows}
          labelField={entity === undefined ? null : labelFieldOf(entity)}
        />
      ) : declaration?.type === "board" && declaration.columns !== undefined ? (
        // ボード（M1.3）。列は `options` に書いた順、強調は API が行に載せた真偽の値をそのまま見る。
        // **空でも列を描く**（空の列も出す）ので、行が 0 件でもボードへ渡す
        <Board
          view={view}
          entity={entity}
          columns={declaration.columns}
          highlight={declaration.highlight}
          displayName={(name) => displayNameOf(view.labels, name)}
          labelOf={(field, value) => displayOf(entity, references, field, value)}
          setActions={setActions}
          renderDelete={renderDelete}
          renderEdit={renderEdit}
          onRunAction={(actionName, id) => void runSetAction(actionName, id)}
        />
      ) : declaration?.type === "list" ? (
        // 一覧（M1.3）。`show` の順に縦へ積み、`filters` で**画面の中だけ**で絞り込む。
        // **空・0 件の見せ方は部品が持つ**——行が無いときと、絞り込んだ結果が 0 件のときで文言を分ける
        <ListScreen
          view={view}
          show={declaration.show}
          filters={filterFields(declaration.filters, entity, references)}
          displayName={(name) => displayNameOf(view.labels, name)}
          labelOf={(field, value) => displayOf(entity, references, field, value)}
          setActions={setActions}
          renderDelete={renderDelete}
          renderEdit={renderEdit}
          onRunAction={(actionName, id) => void runSetAction(actionName, id)}
        />
      ) : view.rows.length === 0 ? (
        <p className="state empty" data-state="empty">
          まだ記録がありません
        </p>
      ) : (
        <RowTable
          view={view}
          entity={entity}
          references={references}
          show={declaration?.show}
          setActions={setActions}
          renderDelete={renderDelete}
          renderEdit={renderEdit}
          onRunAction={(actionName, id) => void runSetAction(actionName, id)}
        />
      )}
      {view !== null && editing !== null && editingRow !== undefined && (
        // 直す（`set` を持たない `kind: update`。M1.5。Issue #215）。**入力欄は追加と同じ部品**を通る
        // ——いまの値を初めの値（`initial`）として渡すだけで、参照・選択肢・既定値・日付の扱いは
        // 1 つも自前で書かない。`key` に行の ID を渡し、別の行を開いたら作り直す
        <section className="edit-form" aria-label="直す">
          <AddForm
            key={editing.id}
            action={editing.action}
            fields={formFields(spec.spec, view.entity ?? "", references)}
            guidance={guidanceOf(spec.spec, view.entity ?? "")}
            initial={editingRow.fields}
            onSubmit={(values) => editRecord(editing.action, editing.id, values)}
          />
        </section>
      )}
      {actionFailure !== null && (
        <p className="state failure" data-state={actionFailure.state} role="alert">
          {actionFailure.message}
        </p>
      )}
      {view !== null && action !== undefined && view.permissions.write && (
        <section className="add" aria-label="追加">
          <AddForm
            action={action.name}
            fields={formFields(spec.spec, view.entity ?? "", references)}
            guidance={guidanceOf(spec.spec, view.entity ?? "")}
            onSubmit={addRecord}
          />
        </section>
      )}
    </main>
  );
}

/** 表の 1 列。名前と、その値を項目から読むか計算から読むか */
interface Column {
  readonly name: string;
  readonly computed: boolean;
}

/**
 * 表の列。**`show` を書いた順**、書かなければ項目（宣言の順）に続いて計算（宣言の順）である
 * （docs/semantics.md「table」）。`show` は項目と計算を同じ並びに置ける。
 */
function columnsOf(view: ApiViewBody, show: readonly string[] | undefined): readonly Column[] {
  if (show === undefined) {
    return [
      ...view.fields.map((name) => ({ name, computed: false })),
      ...view.computed.map((name) => ({ name, computed: true })),
    ];
  }
  return show.map((name) => {
    // 項目と計算の名前は重ならない（静的チェックが断る）ので、応答の項目に無ければ計算である
    const isField = view.fields.includes(name);
    return { name, computed: !isField };
  });
}

/**
 * 一覧の表。列は `show` の順（書かなければ項目 → 計算の宣言の順）。行は API が返した順のまま。
 * 横に長くなるのはこの表だけなので、入れ物（`.table-scroll`）の中でだけ横に流す（360 CSS px のため）。
 *
 * **消す操作（`kind: delete`）を宣言していれば、行ごとに削除の列を足す**（M1.2）。
 * 参照されている行（`row.references` が空でない）には**ボタンを出さず、理由を出す**——
 * ただしこれは見せ方であって守りではなく、実際に断るのは data-api である（`03` §2.2）。
 * **この見せ方は `deleteControl` が 1 つだけ持つ**（一覧・ボードも同じものを通る。Issue #214）。
 */
function RowTable({
  view,
  entity,
  references,
  show,
  setActions,
  renderDelete,
  renderEdit,
  onRunAction,
}: {
  readonly view: ApiViewBody;
  readonly entity: Entity | undefined;
  readonly references: readonly ReferenceData[];
  /** 表に出す名前の順（宣言の `show`）。書いていなければ `undefined` */
  readonly show: readonly string[] | undefined;
  /** その entity の決まった値への書き換え（`set` を持つ操作。M1.3）。宣言の順 */
  readonly setActions: readonly Action[];
  /** 行ごとの消すボタン（参照されている行には理由）。宣言が無ければ `undefined`（列も出さない） */
  readonly renderDelete: RowDeleteControl | undefined;
  /** 行ごとの「直す」（`set` を持たない `kind: update`。M1.5）。宣言が無ければ `undefined` */
  readonly renderEdit: RowEditControl | undefined;
  readonly onRunAction: (actionName: string, id: string) => void;
}) {
  const columns = columnsOf(view, show);
  // 操作の列は、消す・直す・決まった値への書き換えのどれかを宣言しているときだけ出す
  const hasActions = renderDelete !== undefined || renderEdit !== undefined || setActions.length > 0;
  return (
    <div className="table-scroll">
      <table className="instant-table">
        <thead>
          <tr>
            {columns.map((column) => (
              // 見出しは**表示名**（`label`）で出す。無ければ識別子のまま（API が返した `labels` を見る）
              <th key={column.name} scope="col">
                {displayNameOf(view.labels, column.name)}
              </th>
            ))}
            {hasActions && (
              <th scope="col" className="actions">
                操作
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td key={column.name}>
                  {column.computed
                    ? computedText(row.computed[column.name])
                    : displayOf(entity, references, column.name, row.fields[column.name])}
                </td>
              ))}
              {hasActions && (
                <td className="actions">
                  {/*
                    決まった値への書き換え（M1.3）。**`when` が偽の行ではボタンを出さない**——
                    判定するのは data-api で、画面は返ってきた `allowedActions` を見るだけである
                  */}
                  {setActions
                    .filter((candidate) => isActionAllowed(row, candidate.name))
                    .map((candidate) => (
                      <button
                        key={candidate.name}
                        type="button"
                        className="run-action"
                        data-action={candidate.name}
                        data-row={row.id}
                        onClick={() => onRunAction(candidate.name, row.id)}
                      >
                        {candidate.name}
                      </button>
                    ))}
                  {/* 行ごとの消すボタン（参照されている行には理由）。**一覧・ボードと 1 つの処理**（Issue #214） */}
                  {renderDelete?.(row)}
                  {/* 行ごとの「直す」。**一覧・ボードと 1 つの処理**（M1.5。Issue #215） */}
                  {renderEdit?.(row)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 行ごとの「消す」の見せ方（Issue #214）。**表（table）・一覧（list）・ボード（board）が、この 1 つの
 * 処理を通る**——消すボタンの出し方も、参照されている行に出す断りも、ここで決める（部品ごとに書かない）。
 *
 * - その行で消す操作を実行してよいか（`row.allowedActions`）……だめなら**何も出さない**
 * - 参照されている行（`row.references` が空でない）……**ボタンを出さず、消せない理由を出す**
 * - それ以外……**消すボタン**を出す
 *
 * **隠すのは守りではない**——断るのは data-api である（`03` §2.2）。
 */
function deleteControl(
  row: ApiRow,
  deleteAction: ApiActionRef,
  onDelete: (id: string) => void,
): ReactNode {
  if (!isActionAllowed(row, deleteAction.name)) return null;
  if (!isDeletable(row)) {
    return (
      <span className="delete-blocked" data-blocked="true">
        {blockedReason(row.references ?? [])}
      </span>
    );
  }
  return (
    <button type="button" className="delete" data-delete={row.id} onClick={() => onDelete(row.id)}>
      削除
    </button>
  );
}

/**
 * 行ごとの「消す」の見せ方（`deleteControl` を、1 つの宣言と 1 つの処理に閉じたもの。Issue #214）。
 * **部品は、渡されたこの関数を呼ぶだけである**——宣言が無ければ `undefined` で、操作の欄そのものを出さない。
 */
type RowDeleteControl = (row: ApiRow) => ReactNode;

/**
 * 行ごとの「直す」の見せ方（`set` を持たない `kind: update`。M1.5。Issue #215）。**表（table）・
 * 一覧（list）・ボード（board）が、この 1 つの処理を通る**——ボタンの出し方も、断られたときの見せ方も、
 * ここで決める（部品ごとに書かない。`deleteControl` と同じ考え方である）。
 *
 * その行で実行してよい操作（`row.allowedActions`）だけを、**宣言の順**にボタンにする。ボタンの印は
 * 「直す」である（`deleteControl` が「削除」であるのと同じである）。**隠すのは守りではない**——
 * 断るのは data-api である（`03` §2.2。だから、サーバが断ったら理由をその場に出す）。
 */
function editControl(
  row: ApiRow,
  editActions: readonly Action[],
  onEdit: (actionName: string, id: string) => void,
): ReactNode {
  const allowed = editActions.filter((action) => isActionAllowed(row, action.name));
  if (allowed.length === 0) return null;
  return (
    <>
      {allowed.map((action) => (
        <button
          key={action.name}
          type="button"
          className="edit"
          data-edit={row.id}
          data-action={action.name}
          onClick={() => onEdit(action.name, row.id)}
        >
          直す
        </button>
      ))}
    </>
  );
}

/**
 * 行ごとの「直す」の見せ方（`editControl` を、1 つの宣言の並びと 1 つの処理に閉じたもの。Issue #215）。
 * **部品は、渡されたこの関数を呼ぶだけである**——宣言が無ければ `undefined` で、操作の欄そのものを出さない。
 */
type RowEditControl = (row: ApiRow) => ReactNode;

/** その行を消せるか。**応答に `references` が無い**（宣言が無い）ときは `false` にしない（列も出ない） */
const isDeletable = (row: ApiRow): boolean =>
  row.references === undefined || row.references.length === 0;

/**
 * その行で、その操作を実行してよいか（M1.3）。**API が返した `allowedActions` をそのまま見る**——
 * 画面は `when` の式を評価しない（`CLAUDE.md` の不変条件）。
 *
 * 欄そのものが無いときは「条件が宣言されていない」であって「何もできない」ではないので `true` にする
 * （M1.2 の応答を変えない）。空の並びは「いまはどの操作もできない」である（読み替えない）。
 */
const isActionAllowed = (row: ApiRow, actionName: string): boolean =>
  row.allowedActions === undefined || row.allowedActions.includes(actionName);

/** 消せない理由。**参照元の entity と項目、件数**をそのまま見せる（サーバが返した値を読み替えない） */
function blockedReason(references: NonNullable<ApiRow["references"]>): string {
  const detail = references.map((reference) => `${reference.entity}.${reference.field} ${reference.count} 件`);
  return `他の記録から参照されています（${detail.join("、")}）`;
}

const isList = (value: ApiValue | undefined): value is readonly string[] => Array.isArray(value);

/** 項目の値。`list` は入力の順のまま読める形にし、無い値は空欄にする */
function fieldText(value: ApiValue | undefined): string {
  if (value === undefined) return "";
  if (isList(value)) return value.join(", ");
  return String(value);
}

/**
 * 項目の値の表示。**一覧・ボード・表・順位の部品が共通で通る 1 つの処理**である（Issue #204）。
 *
 * 1. **選択肢（`enum`）** … 保存されているのはキーなので、宣言の `options` の表示名に写す
 *    （`form` の入力欄・`groupHeadingOf` の見出しと同じ決めごとである）。写せなければキーのまま出す
 * 2. **参照（`ref`・参照の並び）** … ID を画面に名前へ写す（見つからなければ ID のまま出す。
 *    「分からないものを消す」より、分かる範囲をそのまま見せるほうが正直である）
 * 3. それ以外 … 値をそのまま文字にする
 */
function displayOf(
  entity: Entity | undefined,
  references: readonly ReferenceData[],
  field: string,
  value: ApiValue | undefined,
): string {
  const declaration = entity?.fields[field];
  if (declaration === undefined) return fieldText(value);
  // 選択肢（`enum`）の値はキーである。宣言の `options` の表示名に写す（無ければキーのまま）
  if (typeof declaration !== "string" && declaration.type === "enum") {
    return typeof value === "string" ? (declaration.options[value] ?? value) : fieldText(value);
  }
  const target = fieldTarget(declaration);
  if (target === null) return fieldText(value);
  const data = references.find((item) => item.entity === target);
  if (isList(value)) return value.map((id) => labelOf(data, id)).join(", ");
  return typeof value === "string" ? labelOf(data, value) : "";
}

/**
 * 計算の値。**返ってきた値をそのまま見せる**（画面は式も集計も評価しない）。
 * 求められなかった計算の `null` は「—」で見せ、**0 と区別する**（M1.2。docs/semantics.md「aggregate」）。
 *
 * **数は小数第 1 位まで、四捨五入で見せる**（M1.4。Issue #177。docs/semantics.md「avg」の決めごと）。
 * 割り算の結果（`1 回あたりの参加`）を読める桁に揃えるためである。**整数はそのまま見せる**
 * （`2000` を `2000.0` にしない）。丸めるのは**見せ方だけ**で、値そのものは API が返した数のままである。
 */
function computedText(value: number | boolean | null | undefined): string {
  if (value === null) return "—";
  if (value === undefined) return "";
  if (typeof value === "number") return numberText(value);
  return String(value);
}

/** 数を、小数第 1 位まで（四捨五入）で見せる。整数はそのままである */
function numberText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 見出しごとの集計（M1.4。Issue #179）の**見出しの表示名**。`enum` で分けたものは、宣言の
 * `options` の表示名に写す（無ければキーのまま）——**送られてくるのはキーで、見せるのは表示名**である
 * （`enum` の入力欄と同じ考え方である）。月（`YYYY-MM`）はそのまま出す。
 *
 * 宣言を引けない（計算や項目が無い）ときは、受け取った見出しをそのまま出す（**分からないものを消さない**）。
 */
function groupHeadingOf(spec: AppSpec, name: string, heading: string): string {
  const entry = spec.computed.find((candidate) => candidate.name === name);
  if (entry === undefined || !("aggregate" in entry)) return heading;
  const grouping = entry.aggregate.groupBy;
  if (grouping === undefined || grouping.month) return heading;
  const entity = spec.entities.find((candidate) => candidate.name === entry.aggregate.entity);
  const declaration = entity?.fields[grouping.field];
  if (declaration === undefined || typeof declaration === "string" || declaration.type !== "enum") {
    return heading;
  }
  return declaration.options[heading] ?? heading;
}

/**
 * その entity の項目と計算の表示名（宣言の `label`。Issue #204）。**無ければその名前は入らない**
 * ——画面は `displayNameOf` を通し、無ければ識別子をそのまま出す（ほかの画面と同じ規則である）。
 *
 * **順位の部品のために要る**——ダッシュボードは `entity` を持たず、一覧の応答に `labels` が載らない
 * ので、別の entity（順位が並べる相手）の表示名は、手元の宣言から引くしかない。
 */
function entityLabelsOf(spec: AppSpec, entityName: string): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  const entity = spec.entities.find((candidate) => candidate.name === entityName);
  if (entity === undefined) return labels;
  for (const [name, declaration] of Object.entries(entity.fields)) {
    if (typeof declaration !== "string" && declaration.label !== undefined) {
      labels[name] = declaration.label;
    }
  }
  for (const computed of spec.computed) {
    if (computed.entity === entityName && computed.label !== undefined) {
      labels[computed.name] = computed.label;
    }
  }
  return labels;
}

function failed(error: ClientError): ScreenState {
  if (error.code === "NOT_FOUND") return { kind: "failed", reason: "notFound" };
  if (error.code === "PERMISSION_DENIED") return { kind: "failed", reason: "forbidden" };
  return { kind: "failed", reason: "network" };
}

/** 一覧と、その entity が参照する entity の候補を読む（#106） */
async function loadView(
  client: MusunestClient,
  instanceId: string,
  spec: ApiSpecBody,
  name: string,
): Promise<ScreenState> {
  const loaded = await client.getView(instanceId, name);
  if (!loaded.ok) return failed(loaded.error);
  const references = await loadReferences(client, instanceId, spec, loaded.value);
  if (!references.ok) return failed(references.error);
  return { kind: "ready", spec, view: loaded.value, references: references.value };
}

/**
 * 一覧の entity が参照する entity の候補を読む。参照の項目が無ければ 1 つも読まない。
 * 参照先に一覧（view）が無ければ、候補は 0 件にする（**架空の ID を作らない**）。
 */
async function loadReferences(
  client: MusunestClient,
  instanceId: string,
  spec: ApiSpecBody,
  view: ApiViewBody,
): Promise<ClientResult<readonly ReferenceData[]>> {
  const entity = spec.spec.entities.find((item) => item.name === view.entity);
  if (entity === undefined) return { ok: true, value: [] };

  const targets = [
    ...new Set(
      Object.values(entity.fields)
        .map((declaration) => fieldTarget(declaration))
        .filter((target): target is string => target !== null),
    ),
  ];

  const loaded: ReferenceData[] = [];
  for (const target of targets) {
    const targetEntity = spec.spec.entities.find((item) => item.name === target);
    const targetView = spec.spec.views.find((item) => item.entity === target);
    if (targetEntity === undefined || targetView === undefined) {
      loaded.push({ entity: target, labelField: null, rows: [] });
      continue;
    }
    const result = await client.getView(instanceId, targetView.name);
    if (!result.ok) return { ok: false, error: result.error };
    loaded.push({ entity: target, labelField: labelFieldOf(targetEntity), rows: result.value.rows });
  }
  return { ok: true, value: loaded };
}

/** 参照先を画面に出す名前の項目。**先頭の文字列の項目**を使う（`label` の語彙はまだ無い。M1.2） */
function labelFieldOf(entity: Entity): string | null {
  for (const [name, declaration] of Object.entries(entity.fields)) {
    if (fieldKind(declaration) === "string") return name;
  }
  return null;
}

/** 参照の値（ID）の表示名。見つからなければ ID をそのまま返す */
function labelOf(data: ReferenceData | undefined, id: string): string {
  if (data === undefined) return id;
  const row = data.rows.find((item) => item.id === id);
  const field = data.labelField;
  if (row === undefined || field === null) return id;
  const label = row.fields[field];
  return typeof label === "string" && label !== "" ? label : id;
}

/** 操作の種類（M1.2）。**書いていなければ `create`** である（宣言の省略の意味を画面でも同じに読む） */
const kindOf = (action: ApiActionRef): string => action.kind ?? "create";

/**
 * その entity の**追加**の操作（`kind: create`、または種類の指定が無いもの）。
 * view が返したもの（宣言の順）を先に探す。
 */
function addActionOf(spec: ApiSpecBody, view: ApiViewBody): ApiActionRef | undefined {
  return (
    view.actions.find((action) => action.entity === view.entity && kindOf(action) === "create") ??
    spec.actions.find((action) => action.entity === view.entity && kindOf(action) === "create")
  );
}

/**
 * その entity の**決まった値への書き換え**の操作（`set` を持つ `kind: update`。M1.3）。宣言の順。
 * **正本は宣言（`spec.spec.actions`）である**——一覧の応答（`ApiActionRef`）は `set` を持たない。
 */
function setActionsOf(spec: ApiSpecBody, view: ApiViewBody): readonly Action[] {
  return spec.spec.actions.filter(
    (candidate) =>
      candidate.entity === view.entity && candidate.kind === "update" && candidate.set !== undefined,
  );
}

/**
 * その entity の**直す**操作（`set` を持たない `kind: update`。M1.5。Issue #215）。宣言の順。
 * **正本は宣言（`spec.spec.actions`）である**——一覧の応答（`ApiActionRef`）は `set` を持たないので、
 * 「`set` を持つか」で「決まった値への書き換え」と「全項目の置換」を見分けられない。
 * `when` を持つ宣言では、その行で実行してよいかを応答の `allowedActions` が見る（`editControl`）。
 */
function editActionsOf(spec: ApiSpecBody, view: ApiViewBody): readonly Action[] {
  return spec.spec.actions.filter(
    (candidate) =>
      candidate.entity === view.entity && candidate.kind === "update" && candidate.set === undefined,
  );
}

/** その entity の**消す**操作（`kind: delete`）。宣言が無ければ `undefined`（削除ボタンを出さない） */
function deleteActionOf(spec: ApiSpecBody, view: ApiViewBody): ApiActionRef | undefined {
  return (
    view.actions.find((action) => action.entity === view.entity && kindOf(action) === "delete") ??
    spec.actions.find((action) => action.entity === view.entity && kindOf(action) === "delete")
  );
}

/**
 * 消せなかった理由（M1.2）。**サーバが返した参照元と件数をそのまま見せる**——
 * `REFERENCE_IN_USE` に空の並びを読み替えない（`references` が無ければ、コードだけを見せる）。
 */
function reasonOfFailure(error: ClientError): string {
  if (error.code === "ACTION_NOT_ALLOWED") return actionNotAllowedReason(error);
  if (error.code === "REFERENCE_IN_USE") {
    if (error.references === undefined || error.references.length === 0) {
      return "他の記録から参照されているため削除できません。";
    }
    return `他の記録から参照されているため削除できません（${error.references
      .map((reference) => `${reference.entity}.${reference.field} ${reference.count} 件`)
      .join("、")}）。`;
  }
  if (error.code === "NOT_FOUND") return "この記録は既にありません。";
  if (error.code === "PERMISSION_DENIED") return "削除する権限がありません。";
  return "削除できませんでした。";
}

/**
 * 条件が成り立たないと断られた理由（M1.3。409 `ACTION_NOT_ALLOWED`）。
 * **サーバが返した操作の名前と条件をそのまま見せる**（画面が言い換えない）。
 */
function actionNotAllowedReason(error: ClientError): string {
  const name = error.action ?? "この操作";
  if (error.when === undefined) return `${name} はいま実行できません。`;
  return `${name} はいま実行できません（条件 ${error.when}）。`;
}

/**
 * 決まった値への書き換えが断られた理由（M1.3）。**画面の非表示だけに頼らない**ので、
 * サーバの答えをそのまま出す（一覧の `allowedActions` は古くなっていることがある）。
 */
function reasonOfActionFailure(error: ClientError, actionName: string): string {
  if (error.code === "ACTION_NOT_ALLOWED") return actionNotAllowedReason(error);
  if (error.code === "NOT_FOUND") return "この記録は既にありません。";
  if (error.code === "PERMISSION_DENIED") return "操作する権限がありません。";
  return `${actionName} を実行できませんでした。`;
}

/**
 * 入力欄になる項目。**entity の `fields` だけ**を宣言の順に取る（computed・id・日時は入らない）。
 * 参照の項目には、参照先の候補（ID と名前）を付ける。選択肢の項目（`enum`。M1.3）には、
 * **宣言の `options`（キー → 表示名）と `default`** をそのまま付ける。日付（`date`。M1.3）は
 * 種類をそのまま渡すだけで、入力欄（日付の欄）にするのは form.tsx である。
 *
 * **選択肢を絞ることは守りではない。** 宣言に無い値を断るのは data-api だけである（`03` §2.2）。
 */
export function formFields(
  spec: AppSpec,
  entityName: string,
  references: readonly ReferenceData[] = [],
): FormField[] {
  const entity = spec.entities.find((item) => item.name === entityName);
  if (entity === undefined) return [];
  return Object.entries(entity.fields).map(([name, declaration]) => {
    // 表示名（`label`。M1.3。Issue #176）。**無ければ入力欄の名前（識別子）をそのまま出す**。
    // 送る値は変わらない（`name` は識別子のままである）
    const label = typeof declaration === "string" ? undefined : declaration.label;
    const shown = label === undefined ? {} : { label };
    // 選択肢（M1.3）。**送るのはキーで、見せるのは表示名である。** キーの順が選択肢の順である
    if (typeof declaration !== "string" && declaration.type === "enum") {
      return {
        name,
        ...shown,
        type: fieldKind(declaration),
        to: null,
        options: Object.entries(declaration.options).map(([value, label]) => ({ value, label })),
        default: declaration.default ?? null,
      };
    }
    const target = fieldTarget(declaration);
    return {
      name,
      ...shown,
      type: fieldKind(declaration),
      to: target,
      ...(target === null ? {} : { options: optionsOf(references, target) }),
    };
  });
}

/** 参照先の候補。参照先の一覧を読めていなければ空である */
function optionsOf(references: readonly ReferenceData[], target: string): readonly FormOption[] {
  const data = references.find((item) => item.entity === target);
  if (data === undefined) return [];
  return data.rows.map((row) => ({ value: row.id, label: labelOf(data, row.id) }));
}

/**
 * 絞り込みの候補（宣言の `filters` の順。M1.3）。**`enum` か `ref` の項目だけ**を返す——
 * 値の候補を宣言から機械で出せるのが、この 2 つの型だけだからである（docs/semantics.md「filters」）。
 * `enum` は宣言の `options`（**送るのはキー、見せるのは表示名**）を、`ref` は参照先の一覧の行
 * （**送るのは ID、見せるのは名前**）を候補にする。
 *
 * 読めない名前は落とす（**画面は候補をでっち上げない**。正しい宣言では、静的チェックが
 * `UI_FILTER_FIELD_NOT_SHOWN`・`UI_FILTER_FIELD_NOT_FILTERABLE` で先に断る）。
 */
export function filterFields(
  names: readonly string[] | undefined,
  entity: Entity | undefined,
  references: readonly ReferenceData[] = [],
): FilterField[] {
  if (names === undefined || entity === undefined) return [];
  const fields: FilterField[] = [];
  for (const name of names) {
    const declaration = entity.fields[name];
    if (declaration === undefined || typeof declaration === "string") continue;
    if (declaration.type === "enum") {
      fields.push({
        name,
        options: Object.entries(declaration.options).map(([value, label]) => ({ value, label })),
      });
      continue;
    }
    const target = fieldTarget(declaration);
    if (target === null) continue;
    fields.push({ name, options: optionsOf(references, target) });
  }
  return fields;
}

/**
 * **送信の前に**出す、保存できないときの文言（その entity の検査が宣言した `message`。宣言の順）。
 * 画面は式を評価しないので、「いつその文言が出るか」までは決めない——文言そのものを見せるだけである
 * （守りは data-api 側にあり、画面の文言は入力補助である。03-spec-layers-and-checker.md §2.2）。
 */
function guidanceOf(spec: AppSpec, entityName: string): readonly string[] {
  return spec.validations
    .filter((validation) => validation.entity === entityName && validation.message !== undefined)
    .map((validation) => validation.message ?? "");
}
