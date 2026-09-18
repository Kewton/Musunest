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
//
// **参照の候補は、参照先の entity の一覧（view）から取る。** 宣言が参照先の一覧を持たなければ候補は 0 件で、
// 画面は架空の ID を作らない（フォームは「先に登録してください」と出す。守りはサーバ側）。
//
// **インスタンス固有のデータはビルド済みの HTML に埋めない。** この component はブラウザでだけ動き、
// データは同じ origin の `/api/*`（host の Worker が gateway へ中継する。Issue #103）から取る。
// 利用者の入力は React の text node として挿入する（HTML として解釈させない）。

import { useEffect, useState } from "react";
import type {
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
import { fieldKind, fieldTarget } from "@musunest/sdk";
import { AddForm } from "./form";
import type { AddFormResult, FormField, FormOption } from "./form";
import { SettlementList } from "./settlement";
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
  /** 消せなかった理由（M1.2）。**画面の非表示だけに頼らず、サーバの答えを出す** */
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);

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
  // 一覧の種類（`type`）と、表に出す名前の順（`show`）は**宣言**にある。API の応答には行だけがある
  const declaration = view === null ? undefined : spec.spec.views.find((item) => item.name === view.view);
  const entity = view === null ? undefined : spec.spec.entities.find((item) => item.name === view.entity);

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
    setDeleteFailure(null);
    const deleted = await client.deleteRecord(instanceId, actionName, id);
    if (!deleted.ok) {
      setDeleteFailure(reasonOfFailure(deleted.error));
      return;
    }
    setState(await loadView(client, instanceId, spec, view.view));
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
      {view === null ? (
        <p className="state" data-state="noview">
          表示できる一覧がありません
        </p>
      ) : declaration?.type === "settlement" ? (
        // 精算の表示（M1.2）。**画面は計算しない**——API が返した送金の並びを、名前に対応づけて見せる。
        // `settlement` が無い（宣言が無い）ときも `null` として渡し、空の並びに読み替えない
        <SettlementList
          transfers={view.settlement ?? null}
          rows={view.rows}
          labelField={entity === undefined ? null : labelFieldOf(entity)}
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
          deleteAction={deleteAction}
          onDelete={(id) => void removeRecord(deleteAction?.name ?? "", id)}
        />
      )}
      {deleteFailure !== null && (
        <p className="state failure" data-state="delete-failed" role="alert">
          {deleteFailure}
        </p>
      )}
      {view !== null && action !== undefined && view.permissions.write && (
        <section className="add" aria-label="追加">
          <AddForm
            action={action.name}
            fields={formFields(spec.spec, view.entity, references)}
            guidance={guidanceOf(spec.spec, view.entity)}
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
 */
function RowTable({
  view,
  entity,
  references,
  show,
  deleteAction,
  onDelete,
}: {
  readonly view: ApiViewBody;
  readonly entity: Entity | undefined;
  readonly references: readonly ReferenceData[];
  /** 表に出す名前の順（宣言の `show`）。書いていなければ `undefined` */
  readonly show: readonly string[] | undefined;
  /** その entity の消す操作（`kind: delete`）。宣言が無ければ `undefined`（列も出さない） */
  readonly deleteAction: ApiActionRef | undefined;
  readonly onDelete: (id: string) => void;
}) {
  const columns = columnsOf(view, show);
  return (
    <div className="table-scroll">
      <table className="instant-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.name} scope="col">
                {column.name}
              </th>
            ))}
            {deleteAction !== undefined && (
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
              {deleteAction !== undefined && (
                <td className="actions">
                  {isDeletable(row) ? (
                    <button
                      type="button"
                      className="delete"
                      data-delete={row.id}
                      onClick={() => onDelete(row.id)}
                    >
                      削除
                    </button>
                  ) : (
                    // **参照されている行にはボタンを出さない。** 代わりに、消せない理由をその場に出す
                    <span className="delete-blocked" data-blocked="true">
                      {blockedReason(row.references ?? [])}
                    </span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** その行を消せるか。**応答に `references` が無い**（宣言が無い）ときは `false` にしない（列も出ない） */
const isDeletable = (row: ApiRow): boolean =>
  row.references === undefined || row.references.length === 0;

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
 * 参照の項目の値。**ID を画面に名前へ写す**（見つからなければ ID のまま出す。
 * 「分からないものを消す」より、分かる範囲をそのまま見せるほうが正直である）。
 */
function displayOf(
  entity: Entity | undefined,
  references: readonly ReferenceData[],
  field: string,
  value: ApiValue | undefined,
): string {
  const declaration = entity?.fields[field];
  const target = declaration === undefined ? null : fieldTarget(declaration);
  if (target === null) return fieldText(value);
  const data = references.find((item) => item.entity === target);
  if (isList(value)) return value.map((id) => labelOf(data, id)).join(", ");
  return typeof value === "string" ? labelOf(data, value) : "";
}

/**
 * 計算の値。**返ってきた値をそのまま見せる**（画面は式も集計も評価しない）。
 * 求められなかった計算の `null` は「—」で見せ、**0 と区別する**（M1.2。docs/semantics.md「aggregate」）。
 */
function computedText(value: number | null | undefined): string {
  return value === null ? "—" : value === undefined ? "" : String(value);
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
    // 選択肢（M1.3）。**送るのはキーで、見せるのは表示名である。** キーの順が選択肢の順である
    if (typeof declaration !== "string" && declaration.type === "enum") {
      return {
        name,
        type: fieldKind(declaration),
        to: null,
        options: Object.entries(declaration.options).map(([value, label]) => ({ value, label })),
        default: declaration.default ?? null,
      };
    }
    const target = fieldTarget(declaration);
    return {
      name,
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
 * **送信の前に**出す、保存できないときの文言（その entity の検査が宣言した `message`。宣言の順）。
 * 画面は式を評価しないので、「いつその文言が出るか」までは決めない——文言そのものを見せるだけである
 * （守りは data-api 側にあり、画面の文言は入力補助である。03-spec-layers-and-checker.md §2.2）。
 */
function guidanceOf(spec: AppSpec, entityName: string): readonly string[] {
  return spec.validations
    .filter((validation) => validation.entity === entityName && validation.message !== undefined)
    .map((validation) => validation.message ?? "");
}
