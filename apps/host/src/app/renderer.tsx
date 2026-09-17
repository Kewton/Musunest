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
        <RowTable view={view} entity={entity} references={references} show={declaration?.show} />
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
 */
function RowTable({
  view,
  entity,
  references,
  show,
}: {
  readonly view: ApiViewBody;
  readonly entity: Entity | undefined;
  readonly references: readonly ReferenceData[];
  /** 表に出す名前の順（宣言の `show`）。書いていなければ `undefined` */
  readonly show: readonly string[] | undefined;
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

/** その entity の追加の操作。view が返したもの（宣言の順）を先に探す */
function addActionOf(spec: ApiSpecBody, view: ApiViewBody): ApiActionRef | undefined {
  return (
    view.actions.find((action) => action.entity === view.entity) ??
    spec.actions.find((action) => action.entity === view.entity)
  );
}

/**
 * 入力欄になる項目。**entity の `fields` だけ**を宣言の順に取る（computed・id・日時は入らない）。
 * 参照の項目には、参照先の候補（ID と名前）を付ける。
 */
export function formFields(
  spec: AppSpec,
  entityName: string,
  references: readonly ReferenceData[] = [],
): FormField[] {
  const entity = spec.entities.find((item) => item.name === entityName);
  if (entity === undefined) return [];
  return Object.entries(entity.fields).map(([name, declaration]) => {
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
