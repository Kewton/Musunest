// Instant Renderer — 宣言から、一覧と追加フォームをその場で描く画面（Issue #104）。
//
// **画面は式を評価しない。** 計算値も「操作してよいか」も data-api が返したものをそのまま見せる
// （workspace/mvp/m1/README.md §4「計算はサーバ側」）。だからこの画面が決めるのは、次の3つだけである。
//   1. どの状態を描くか — 読込中・空一覧・未存在（404）・権限不足（403）・通信失敗を区別する
//   2. 一覧の並べ方 — 項目を宣言の順、続いて計算を宣言の順。行は API が返した順（登録順）のまま
//   3. 追加フォームを出すか — view が返した `permissions.write` と、その entity の action の有無だけで決める
//
// **インスタンス固有のデータはビルド済みの HTML に埋めない。** この component はブラウザでだけ動き、
// データは同じ origin の `/api/*`（host の Worker が gateway へ中継する。Issue #103）から取る。
// 利用者の入力は React の text node として挿入する（HTML として解釈させない）。

import { useEffect, useState } from "react";
import type { ApiActionRef, ApiSpecBody, ApiValue, ApiViewBody, AppSpec, ClientError, MusunestClient } from "@musunest/sdk";
import { AddForm } from "./form";
import type { AddFormResult, FormField } from "./form";
import "./renderer.css";

/** 読めなかった理由。**状態を1つに潰さない**（未存在・権限不足・通信失敗を区別して描く） */
export type FailureReason = "notFound" | "forbidden" | "network";

type ScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: FailureReason }
  | { readonly kind: "ready"; readonly spec: ApiSpecBody; readonly view: ApiViewBody | null };

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
      const next = spec.ok ? await firstView(client, instanceId, spec.value) : failed(spec.error);
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

  const { spec, view } = state;
  const action = view === null ? undefined : addActionOf(spec, view);

  /** 一覧の切替。読めなければ同じ理由の画面に落とす（読めなかったことは隠さない） */
  async function showView(name: string): Promise<void> {
    const loaded = await client.getView(instanceId, name);
    setState(loaded.ok ? { kind: "ready", spec, view: loaded.value } : failed(loaded.error));
  }

  /** 追加。成功したら**一覧を読み直す**（返ってきた行を勝手に足さない）。失敗は入力欄に返す */
  async function addRecord(values: Readonly<Record<string, ApiValue>>): Promise<AddFormResult> {
    if (view === null || action === undefined) return { ok: false };
    const created = await client.addRecord(instanceId, action.name, values);
    if (!created.ok) {
      return { ok: false, fields: created.error.fields, validations: created.error.validations };
    }
    const refreshed = await client.getView(instanceId, view.view);
    if (!refreshed.ok) {
      setState(failed(refreshed.error));
      return { ok: true };
    }
    setState({ kind: "ready", spec, view: refreshed.value });
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
      ) : view.rows.length === 0 ? (
        <p className="state empty" data-state="empty">
          まだ記録がありません
        </p>
      ) : (
        <RowTable view={view} />
      )}
      {view !== null && action !== undefined && view.permissions.write && (
        <section className="add" aria-label="追加">
          <AddForm action={action.name} fields={formFields(spec.spec, view.entity)} onSubmit={addRecord} />
        </section>
      )}
    </main>
  );
}

/** 一覧の表。列は項目（宣言の順）→ 計算（宣言の順）。行は API が返した順のまま */
function RowTable({ view }: { readonly view: ApiViewBody }) {
  return (
    <div className="table-scroll">
      <table className="instant-table">
        <thead>
          <tr>
            {view.fields.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
            {view.computed.map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.id}>
              {view.fields.map((name) => (
                <td key={name}>{fieldText(row.fields[name])}</td>
              ))}
              {view.computed.map((name) => (
                <td key={name}>{computedText(row.computed[name])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const isList = (value: ApiValue | undefined): value is readonly string[] =>
  Array.isArray(value);

/** 項目の値。`list` は入力の順のまま読める形にし、無い値は空欄にする */
function fieldText(value: ApiValue | undefined): string {
  if (value === undefined) return "";
  if (isList(value)) return value.join(", ");
  return String(value);
}

/** 計算の値。**返ってきた値をそのまま見せる**（求められなかった計算の `null` は空欄） */
function computedText(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function failed(error: ClientError): ScreenState {
  if (error.code === "NOT_FOUND") return { kind: "failed", reason: "notFound" };
  if (error.code === "PERMISSION_DENIED") return { kind: "failed", reason: "forbidden" };
  return { kind: "failed", reason: "network" };
}

async function firstView(
  client: MusunestClient,
  instanceId: string,
  spec: ApiSpecBody,
): Promise<ScreenState> {
  const first = spec.spec.views[0];
  if (first === undefined) return { kind: "ready", spec, view: null };
  const view = await client.getView(instanceId, first.name);
  return view.ok ? { kind: "ready", spec, view: view.value } : failed(view.error);
}

/** その entity の追加の操作。view が返したもの（宣言の順）を先に探す */
function addActionOf(spec: ApiSpecBody, view: ApiViewBody): ApiActionRef | undefined {
  return (
    view.actions.find((action) => action.entity === view.entity) ??
    spec.actions.find((action) => action.entity === view.entity)
  );
}

/** 入力欄になる項目。**entity の `fields` だけ**を宣言の順に取る（computed・id・日時は入らない） */
export function formFields(spec: AppSpec, entityName: string): FormField[] {
  const entity = spec.entities.find((item) => item.name === entityName);
  if (entity === undefined) return [];
  return Object.entries(entity.fields).map(([name, type]) => ({ name, type }));
}
