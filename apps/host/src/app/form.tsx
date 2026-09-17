// 種類の指定の無い action から作る追加フォーム（Issue #104）。
//
// **画面は宣言をそのまま入力欄にする。** 項目を宣言の順に並べ、型ごとに次の形で送る
// （packages/appspec-schema/docs/semantics.md「string」「number」「list」「action」）。
//   string → 文字列（空文字も 1 つの値としてそのまま送る）
//   number → JSON の数（有限の数にならない入力は、勝手に 0 や NaN にせず文字列のまま送る。
//            型の検査は data-api が行い、通らなかった項目の名前が返る）
//   list   → 文字列の並び（1 行に 1 つ。空行も重複も順序も、入力補助で勝手に削らない）
//
// **computed・id・日時は入力欄にしない。** 入力欄になるのは entity の `fields` だけで、
// 呼ぶ側（renderer.tsx）がそれを宣言の順に渡す。画面では式も権限条件も評価しない——
// 断るかどうかは data-api が返す `fields`・`validations` をそのまま見せる（文言は #106）。

import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { ApiValue, FieldType } from "@musunest/sdk";

/** 入力欄にする項目（名前と型）。宣言の順で渡す */
export interface FormField {
  readonly name: string;
  readonly type: FieldType;
}

/** 送信の結果。失敗のときは、data-api が返した項目名と検査名をそのまま載せる */
export interface AddFormResult {
  readonly ok: boolean;
  readonly fields?: readonly string[];
  readonly validations?: readonly string[];
}

export interface AddFormProps {
  readonly action: string;
  readonly fields: readonly FormField[];
  readonly onSubmit: (values: Readonly<Record<string, ApiValue>>) => Promise<AddFormResult>;
}

export function AddForm({ action, fields, onSubmit }: AddFormProps) {
  const [text, setText] = useState<Record<string, string>>(() => emptyText(fields));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AddFormResult | null>(null);
  // 送信中の二重押下を防ぐ。**disabled だけに頼らない**——同じ tick の 2 回目を弾く
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);

    const result = await onSubmit(toValues(fields, text));
    // 成功したら入力欄を空に戻す。失敗したら**入力値をそのまま残す**（打ち直させない）
    if (result.ok) setText(emptyText(fields));
    else setFailure(result);

    inFlight.current = false;
    setPending(false);
  }

  const change = (name: string) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = event.target.value;
    setText((current) => ({ ...current, [name]: value }));
  };

  return (
    <form className="add-form" aria-label={`${action} のフォーム`} onSubmit={(event) => void submit(event)}>
      {fields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={inputId(field.name)}>{field.name}</label>
          {field.type === "list" ? (
            <textarea
              id={inputId(field.name)}
              name={field.name}
              className="field-input"
              rows={3}
              value={text[field.name] ?? ""}
              onChange={change(field.name)}
            />
          ) : (
            <input
              id={inputId(field.name)}
              name={field.name}
              className="field-input"
              type="text"
              inputMode={field.type === "number" ? "decimal" : "text"}
              value={text[field.name] ?? ""}
              onChange={change(field.name)}
            />
          )}
        </div>
      ))}
      {failure !== null && <FailureNotice failure={failure} />}
      <button type="submit" className="submit" disabled={pending}>
        {pending ? "送信中…" : "保存"}
      </button>
    </form>
  );
}

function FailureNotice({ failure }: { readonly failure: AddFormResult }) {
  const fields = failure.fields ?? [];
  const validations = failure.validations ?? [];
  return (
    <div className="failure" role="alert">
      <p className="failure-message">保存できませんでした。</p>
      {fields.length > 0 && <p className="failure-fields">項目: {fields.join(", ")}</p>}
      {validations.length > 0 && <p className="failure-validations">検査: {validations.join(", ")}</p>}
    </div>
  );
}

const inputId = (name: string): string => `field-${name}`;

function emptyText(fields: readonly FormField[]): Record<string, string> {
  const text: Record<string, string> = {};
  for (const field of fields) text[field.name] = "";
  return text;
}

/** 入力欄の文字列を、宣言の型の値にして送る */
function toValues(
  fields: readonly FormField[],
  text: Readonly<Record<string, string>>,
): Record<string, ApiValue> {
  const values: Record<string, ApiValue> = {};
  for (const field of fields) {
    const raw = text[field.name] ?? "";
    if (field.type === "list") values[field.name] = splitList(raw);
    else if (field.type === "number") values[field.name] = toNumber(raw);
    else values[field.name] = raw;
  }
  return values;
}

/** 1 行に 1 つ。**空行も重複も順序も残す**（意味の決定は data-api が行う） */
function splitList(raw: string): string[] {
  return raw.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** 有限の数になるときだけ数にする。ならない入力は文字列のまま送り、型の検査に委ねる */
function toNumber(raw: string): number | string {
  if (raw.trim() === "") return raw;
  const value = Number(raw);
  return Number.isFinite(value) ? value : raw;
}
