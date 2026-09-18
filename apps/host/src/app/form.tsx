// 種類の指定の無い action から作る追加フォーム（Issue #104。参照と文言は #106、選択肢と既定値は #154）。
//
// **画面は宣言をそのまま入力欄にする。** 項目を宣言の順に並べ、種類ごとに次の形で送る
// （packages/appspec-schema/docs/semantics.md「string」「number」「list」「ref」「enum」「action」）。
//   string → 文字列（空文字も 1 つの値としてそのまま送る）
//   number → JSON の数（有限の数にならない入力は、勝手に 0 や NaN にせず文字列のまま送る。
//            型の検査は data-api が行い、通らなかった項目の名前が返る）
//   list   → 文字列の並び（1 行に 1 つ。空行も重複も順序も、入力補助で勝手に削らない）
//   ref    → 参照先のレコード 1 件の選択（単一選択）。**送るのは ID で、見せるのは名前である**
//   list of → 参照先のレコードの複数選択（チェック）。候補の順に、選んだ ID を送る
//   enum   → 選択肢の単一選択（M1.3）。**見せるのは表示名で、送るのはキーである。**
//            既定値があれば最初から選んでおく（未入力を空文字で送ると、既定値が入らないため）
//   date   → 日付の入力欄（M1.3）。**送るのは `YYYY-MM-DD` の文字列である。** 未入力は空のまま送る
//            （今日を勝手に入れない。断るのは data-api である）
//
// **enum の選択肢を絞ることは守りではない。** 宣言に無い値を断るのは data-api だけである
// （`03-spec-layers-and-checker.md` §2.2。`CLAUDE.md` の不変条件）。
//
// **computed・id・日時は入力欄にしない。** 入力欄になるのは entity の `fields` だけで、
// 呼ぶ側（renderer.tsx）がそれを宣言の順に渡す。画面では式も権限条件も評価しない——
// 断るかどうかは data-api が返す `fields`・`validations`・`validationMessages` をそのまま見せる。
//
// **候補が 0 件でも架空の ID を作らない。** 選べないことを伝え、先に登録してもらう（守りはサーバ側）。
// 検査の文言は**テキストとして**表示する（HTML として解釈させない）。

import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { ApiValue, FieldKind } from "@musunest/sdk";

/** 参照の候補。`value` が API に送る ID、`label` が画面に出す名前である（Issue #106） */
export interface FormOption {
  readonly value: string;
  readonly label: string;
}

/** 入力欄にする項目（名前と種類）。参照の項目は、参照先と候補も持つ。宣言の順で渡す */
export interface FormField {
  readonly name: string;
  readonly type: FieldKind;
  /** 参照先の entity の名前（`ref`・参照 list）。参照でなければ `null` */
  readonly to?: string | null;
  /**
   * 選択肢。参照（`ref`・参照 list）は参照先の候補（送るのは ID、見せるのは名前）で、
   * 選択肢の項目（`enum`）は宣言の `options`（送るのはキー、見せるのは表示名）である（M1.3）
   */
  readonly options?: readonly FormOption[];
  /** 選択肢の項目で、最初から選んでおくキー（宣言の `default`）。無ければ `null`（M1.3） */
  readonly default?: string | null;
}

/** 送信の結果。失敗のときは、data-api が返した項目名・検査名・文言をそのまま載せる */
export interface AddFormResult {
  readonly ok: boolean;
  readonly fields?: readonly string[];
  readonly validations?: readonly string[];
  /** 通らなかった検査の文言（`validations` と同じ並び）。文言が無ければ `null` */
  readonly validationMessages?: readonly (string | null)[];
}

export interface AddFormProps {
  readonly action: string;
  readonly fields: readonly FormField[];
  /**
   * 保存できないときの文言（その entity の検査が宣言した `message`。宣言の順）。
   * **送信の前に**出す入力補助である——守りは data-api 側にあり、画面は文言をそのまま見せるだけである。
   */
  readonly guidance?: readonly string[];
  readonly onSubmit: (values: Readonly<Record<string, ApiValue>>) => Promise<AddFormResult>;
}

/** 入力欄が持つ値。文字の欄は文字列、参照 list は選んだ ID の並びである */
type FormText = Readonly<Record<string, string | readonly string[]>>;

/** 参照の並び（複数選択）の欄か */
const isRefList = (field: FormField): boolean => field.type === "list" && (field.to ?? null) !== null;

export function AddForm({ action, fields, guidance = [], onSubmit }: AddFormProps) {
  const [text, setText] = useState<FormText>(() => emptyState(fields));
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
    if (result.ok) setText(emptyState(fields));
    else setFailure(result);

    inFlight.current = false;
    setPending(false);
  }

  const change = (name: string) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const value = event.target.value;
    setText((current) => ({ ...current, [name]: value }));
  };

  const toggle = (name: string) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    const checked = event.target.checked;
    setText((current) => {
      const chosen = Array.isArray(current[name]) ? current[name] : [];
      const next = checked ? [...chosen, value] : chosen.filter((item) => item !== value);
      return { ...current, [name]: next };
    });
  };

  return (
    <form className="add-form" aria-label={`${action} のフォーム`} onSubmit={(event) => void submit(event)}>
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={text[field.name] ?? (isRefList(field) ? [] : "")}
          onChange={change(field.name)}
          onToggle={toggle(field.name)}
        />
      ))}
      {failure !== null && <FailureNotice failure={failure} />}
      {guidance.length > 0 && <Guidance messages={guidance} />}
      <button type="submit" className="submit" disabled={pending}>
        {pending ? "送信中…" : "保存"}
      </button>
    </form>
  );
}

/** 送信の前に出す、保存できないときの文言（宣言の `message`）。**テキストとして出す** */
function Guidance({ messages }: { readonly messages: readonly string[] }) {
  return (
    <ul className="guidance" aria-label="保存する条件">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  onToggle,
}: {
  readonly field: FormField;
  readonly value: string | readonly string[];
  readonly onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  readonly onToggle: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const options = field.options ?? [];

  if (isRefList(field)) {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="field" data-field={field.name}>
        <legend>{field.name}</legend>
        {options.length === 0 ? (
          <EmptyCandidates />
        ) : (
          options.map((option) => (
            <label className="choice" key={option.value}>
              <input
                type="checkbox"
                name={field.name}
                value={option.value}
                checked={chosen.includes(option.value)}
                onChange={onToggle}
              />
              {option.label}
            </label>
          ))
        )}
      </fieldset>
    );
  }

  const text = typeof value === "string" ? value : "";
  return (
    <div className="field" data-field={field.name}>
      <label htmlFor={inputId(field.name)}>{field.name}</label>
      {field.type === "enum" ? (
        // 選択肢（M1.3）。**見せるのは表示名で、送るのはキーである。** 選ばれていなければ空文字を送り、
        // 断るのは data-api である（既定値は呼ぶ側が最初から選んでおく）
        <select
          id={inputId(field.name)}
          name={field.name}
          className="field-input"
          value={text}
          onChange={onChange}
        >
          <option value="">（選んでください）</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === "ref" ? (
        <>
          <select
            id={inputId(field.name)}
            name={field.name}
            className="field-input"
            value={text}
            onChange={onChange}
          >
            <option value="">（選んでください）</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {options.length === 0 && <EmptyCandidates />}
        </>
      ) : field.type === "list" ? (
        <textarea
          id={inputId(field.name)}
          name={field.name}
          className="field-input"
          rows={3}
          value={text}
          onChange={onChange}
        />
      ) : field.type === "date" ? (
        // 日付（M1.3）。**未入力は空のまま送る**（今日を勝手に入れない。守りは data-api 側にある）。
        // ブラウザの日付の入力欄が送る値は `YYYY-MM-DD` である（保存する形と同じ。docs/semantics.md「date」）
        <input
          id={inputId(field.name)}
          name={field.name}
          className="field-input"
          type="date"
          value={text}
          onChange={onChange}
        />
      ) : (
        <input
          id={inputId(field.name)}
          name={field.name}
          className="field-input"
          type="text"
          inputMode={field.type === "number" ? "decimal" : "text"}
          value={text}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/** 候補が 0 件のときの案内。**架空の ID を作らず、先に登録してもらう** */
function EmptyCandidates() {
  return (
    <p className="field-empty" data-empty="true">
      選べる候補がありません。先に登録してください。
    </p>
  );
}

function FailureNotice({ failure }: { readonly failure: AddFormResult }) {
  const fields = failure.fields ?? [];
  const validations = failure.validations ?? [];
  const messages = failure.validationMessages ?? [];
  return (
    <div className="failure" role="alert">
      <p className="failure-message">保存できませんでした。</p>
      {fields.length > 0 && <p className="failure-fields">項目: {fields.join(", ")}</p>}
      {validations.length > 0 && (
        <ul className="failure-validations">
          {validations.map((name, index) => (
            // 文言があれば文言を、無ければ検査の名前を出す（**どちらもテキストである**）
            <li key={name}>{messages[index] ?? name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const inputId = (name: string): string => `field-${name}`;

function emptyState(fields: readonly FormField[]): FormText {
  const text: Record<string, string | readonly string[]> = {};
  for (const field of fields) text[field.name] = initialText(field);
  return text;
}

/**
 * 入力欄の初期値。参照 list は空の並び、**選択肢（enum）は宣言の既定値を最初から選んでおく**
 * （未入力を空文字で送ると、既定値が入らない。M1.3）。ほかは空文字である。
 */
function initialText(field: FormField): string | readonly string[] {
  if (isRefList(field)) return [];
  if (field.type === "enum") return field.default ?? "";
  return "";
}

/** 入力欄の値を、宣言の種類の値にして送る */
function toValues(fields: readonly FormField[], text: FormText): Record<string, ApiValue> {
  const values: Record<string, ApiValue> = {};
  for (const field of fields) {
    const raw = text[field.name] ?? "";
    if (isRefList(field)) {
      // 候補の順に送る（入力の順ではなく、宣言から決まる順）
      const chosen = new Set(Array.isArray(raw) ? raw : []);
      values[field.name] = (field.options ?? []).map((option) => option.value).filter((id) => chosen.has(id));
    } else if (field.type === "enum") {
      // **送るのはキーである**（表示名ではない）。選ばれていなければ空文字を送り、断るのは data-api
      values[field.name] = typeof raw === "string" ? raw : "";
    } else if (field.type === "ref") {
      // 選ばれていなければ空文字を送る。**ID をでっち上げない**（data-api が断る）
      values[field.name] = typeof raw === "string" ? raw : "";
    } else if (field.type === "list") {
      values[field.name] = splitList(typeof raw === "string" ? raw : "");
    } else if (field.type === "number") {
      values[field.name] = toNumber(typeof raw === "string" ? raw : "");
    } else {
      values[field.name] = typeof raw === "string" ? raw : "";
    }
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
