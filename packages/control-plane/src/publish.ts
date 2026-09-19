// publish の中身（Issue #101）。**検査 → 正規化 → R2 の 2 個 → D1 の登録**の順を、ここ 1 か所に持つ。
//
// 入口（引数の解釈・原本の読取・資格情報の取得・Cloudflare adapter の組立・安全な表示）は
// infra/scripts/publish.ts に置き、**ここには判定だけを置く**（Q14・CLAUDE.md「依存の向き」）。
// `infra/scripts` は pnpm workspace の外で `pnpm lint` の依存の検査が届かないため、中身を
// workspace のパッケージに置く。そうすれば `control-plane → spec-engine` の向きが機械で守られる
// （infra/scripts/dep-graph.mjs）。
//
// 決めたこと（Issue #101・workspace/mvp/m1/README.md §3.1・§10.2）:
//   - 入力は原本のバイト列（UTF-8 の文字列）とインスタンス ID。出力は登録した行（アプリとインスタンス）
//   - 静的チェックと正規化は spec-engine を呼ぶ。**CLI 側に実装を複製しない**（判定が 2 か所に
//     分かれると、CI と publish で結果がずれる）
//   - R2 のキーは原本 SHA を含む決定的な値（`specs/<sha>/app.spec.yaml` と
//     `specs/<sha>/normalized.json`）。#100 の登録契約と #102 の取得契約（登録の `normalized_key` を
//     R2 から読む）が同じキーを使う
//   - 順は 検査 → 正規化 → R2 の 1 個目（原本）→ R2 の 2 個目（正規化した JSON）→ D1（アプリ → インスタンス）
//   - **R2 のどちらかで失敗したらインスタンスを登録しない。D1 で失敗したら成功と報告しない**
//   - **R2 と D1 をまたぐトランザクションがあるかのように扱わない。** 途中で落ちても、同じ入力の再実行で
//     正しい状態へ到達する（R2 の書き込みは同じキーへの上書き、D1 の登録は冪等。src/registry.ts）
//   - 失敗は `PublishFailure.stage` で分ける（R2 の 1 個目・2 個目・D1 の各段）。**例外の文言・
//     資格情報・R2 のキーを説明に載せない**（呼ぶ側がそのまま出しても安全にする）
//
// #175 で足した決めごと（追記1・追記2 の窓口の決定。保存済みのデータの読み方は
// packages/appspec-schema/docs/semantics.md「宣言の差し替え」にある）:
//   - **既定では差し替えない。** 既存インスタンスの参照先が違う SHA-256 なら instance_conflict（従来どおり）
//   - `replace: true` のときだけ、**はっきり差し替える**。差し替えてよい宣言かは、前の原本の
//     正規化した JSON（注入された SpecReader が `normalized_key` から読む）と、後の宣言を比べて決める
//   - 断るのは「entity の名前を変える・消す」「項目を消す」「型（参照先・選択肢のキーを含む）を変える」だけである。
//     **足すのはよい。** データ層（entity と項目）以外の宣言は差し替えてよい
//   - 断ると分かった時点で止める（**R2 にも D1 にも書かない**。登録簿の行は前のまま）
//   - 差し替えは `app_instances` の指し先を変えるだけである。**保存済みのレコードには触れない**
//   - 前の原本の SHA-256 と、後の原本の SHA-256 は結果（`replacedSourceSha256`）に残す。入口が出力に出す
//     （**ホスト名・オリジン・バケット名・Account ID は出さない**。CLAUDE.md）
//
// D1 を実際に触るのは data-api だけである（CLAUDE.md 不変条件）。ここは SQL を書かず、注入された
// RegistryExecutor に任せる（src/contract.ts）。R2 も同じで、書き込みは注入された SpecWriter が行う。

import type { Diagnostic } from "@musunest/spec-engine";
import { normalizeSpec } from "@musunest/spec-engine";
import { FIELD_TYPES, type AppSpec, type FieldKind } from "@musunest/appspec-schema";
import {
  RegistryError,
  type AppInstanceRecord,
  type AppRecord,
  type RegistryErrorCode,
  type RegistryExecutor,
} from "./contract.js";
import { getApp, getInstance, registerApp, registerInstance, replaceInstance } from "./registry.js";

// ── R2 のキー（原本 SHA を含む決定的な値）──────────────────────────────

/** R2 のキーの接頭辞。アプリの宣言は、この下に原本 SHA-256 ごとに 2 個のオブジェクトを持つ。 */
export const SPEC_PREFIX = "specs" as const;
/** 原本（app.spec.yaml）のオブジェクト名 */
export const SOURCE_OBJECT_NAME = "app.spec.yaml" as const;
/** 正規化した JSON のオブジェクト名 */
export const NORMALIZED_OBJECT_NAME = "normalized.json" as const;

/** 原本の R2 キー。`specs/<原本 SHA-256>/app.spec.yaml` */
export const sourceObjectKey = (sourceSha256: string): string =>
  `${SPEC_PREFIX}/${sourceSha256}/${SOURCE_OBJECT_NAME}`;

/** 正規化した JSON の R2 キー。`specs/<原本 SHA-256>/normalized.json` */
export const normalizedObjectKey = (sourceSha256: string): string =>
  `${SPEC_PREFIX}/${sourceSha256}/${NORMALIZED_OBJECT_NAME}`;

// ── 注入する R2 の口 ──────────────────────────────────────────────

/**
 * 宣言の 2 つのオブジェクトを R2 に書く口。実体（Cloudflare の API）は入口（infra/scripts）の adapter が渡す。
 * 同じキーへの上書きを許す（同じ入力の再実行を冪等にする）。
 */
export interface SpecWriter {
  write(key: string, body: string): Promise<void>;
}

/**
 * 宣言のオブジェクトを R2 から読む口（#175。差し替えのときだけ使う）。実体（Cloudflare の API）は
 * 入口（infra/scripts）の adapter が渡す。返すのは、オブジェクトの中身を JSON として読んだ値である
 * （読めなければ `undefined`）。**形の検査はここに置かない**——何が書いてあるかの判定は
 * `isReplaceableDeclaration` が行う。
 */
export interface SpecReader {
  read(key: string): Promise<unknown>;
}

// ── 入力と結果 ────────────────────────────────────────────────────

export interface PublishRequest {
  /** 原本（app.spec.yaml）のバイト列を、UTF-8 の文字列として受け取る。改行もコメントもそのまま */
  readonly source: string;
  /** 宣言を使うインスタンスの ID */
  readonly instanceId: string;
  /**
   * 既存インスタンスの参照先を、**はっきり差し替える**（#175。既定は `false`）。
   * `false`（省略）のときは、参照先が違う SHA-256 なら従来どおり `instance_conflict` で断る。
   * `true` でも、差し替えてよい宣言でなければ `replacement_conflict` で断る（R2 にも D1 にも書かない）。
   */
  readonly replace?: boolean;
}

export interface PublishDeps {
  /** R2（原本と正規化した JSON） */
  readonly specs: SpecWriter;
  /** D1（登録表）。SQL と束縛は registry が持ち、実行だけを任せる */
  readonly registry: RegistryExecutor;
  /**
   * R2 から前の原本の「正規化した JSON」を読む口（#175）。**差し替えのときだけ要る。**
   * 差し替えない経路では読まない（既定の挙動を変えない）。
   */
  readonly readSpec?: SpecReader;
}

/** 失敗した段。検査・R2 の 1 個目・2 個目・D1 のアプリ・D1 のインスタンス。 */
export const PUBLISH_STAGES = ["check", "source", "normalized", "app", "instance"] as const;
export type PublishStage = (typeof PUBLISH_STAGES)[number];

export interface PublishFailure {
  readonly stage: PublishStage;
  /** `check` のときだけ、#97 と同じ診断を持つ。それ以外は空 */
  readonly diagnostics: readonly Diagnostic[];
  /** 人が読む説明。**例外の文言・資格情報・R2 のキーを含めない** */
  readonly message: string;
  /** D1 の既知の失敗（RegistryError）のときだけ。それ以外は `null` */
  readonly code: RegistryErrorCode | null;
}

export interface PublishSuccess {
  readonly ok: true;
  readonly app: AppRecord;
  readonly instance: AppInstanceRecord;
  /**
   * 差し替えたときだけ、**前の原本の SHA-256**（#175）。差し替えでなければ `null`。
   * 入口はこれを、後の原本の SHA-256（`app.sourceSha256`）と組にして出力に残す。
   */
  readonly replacedSourceSha256: string | null;
}

export interface PublishRejection {
  readonly ok: false;
  readonly failure: PublishFailure;
}

export type PublishResult = PublishSuccess | PublishRejection;

// ── 説明（値を持たない）───────────────────────────────────────────

const MESSAGES = {
  check: "宣言が静的チェックに通らない（R2 にも D1 にも書かない）",
  source: "原本を R2 に書けなかった（正規化した JSON も D1 の登録もしない）",
  normalized: "正規化した JSON を R2 に書けなかった（D1 の登録はしない）",
  app: "アプリを D1 に登録できなかった（インスタンスは登録しない）",
  instance: "インスタンスを D1 に登録できなかった（アプリの登録は残る。同じ入力で再実行する）",
} as const satisfies Record<PublishStage, string>;

const REGISTRY_MESSAGES = {
  app_conflict: "同じ SHA-256 に内容の違う宣言は登録できない（既存の登録を変えない）",
  instance_conflict: "既存インスタンスの宣言は暗黙に差し替えない（元の参照を保つ）",
  app_not_found: "未登録のアプリを指すインスタンスは登録できない",
  replacement_conflict:
    "差し替えてよい宣言ではない（項目を消す・型を変える・entity の名前を変える差し替えは断る。登録簿の行は変えない）",
} as const satisfies Record<RegistryErrorCode, string>;

/** 差し替えの下調べで、断る理由。**値（SHA-256・R2 のキー・例外の文言）を持たない説明**にする。 */
const REPLACEMENT_MESSAGES = {
  reader: "差し替えには、前の原本の正規化した JSON を読む口が要る（何も書かない）",
  previous: "前の原本の登録が無い（差し替えは行わない）",
  unreadable: "前の原本の正規化した JSON を読めない（差し替えは行わない）",
} as const;

const reject = (
  stage: PublishStage,
  message: string,
  diagnostics: readonly Diagnostic[] = [],
  code: RegistryErrorCode | null = null,
): PublishRejection => ({ ok: false, failure: { stage, diagnostics, message, code } });

/** D1 の失敗を、既知のコード（RegistryError）と、想定外の失敗で言い分ける。どちらも値を持たない説明にする */
const rejectRegistry = (stage: "app" | "instance", thrown: unknown): PublishRejection =>
  thrown instanceof RegistryError
    ? reject(stage, REGISTRY_MESSAGES[thrown.code], [], thrown.code)
    : reject(stage, MESSAGES[stage]);

// ── 差し替えてよい宣言か（#175）─────────────────────────────────────

/** 写像として読める値か（R2 から読んだ値の形を、信用せずに確かめる） */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 項目の「型」。種類と、参照先（`ref` の `to`・`list of` の `of`）と、選択肢（`enum`）のキー。 */
interface FieldShape {
  readonly kind: FieldKind;
  readonly target: string | null;
  readonly optionKeys: readonly string[];
}

/**
 * 項目（宣言から読んだ値）を、型として読む。**読めなければ `null`**（＝差し替えない）。
 * R2 から読んだ前の宣言はこちらが書いたものだが、形を信用しない（読めない値で落ちない）。
 */
function readFieldShape(field: unknown): FieldShape | null {
  if (typeof field === "string") {
    return (FIELD_TYPES as readonly string[]).includes(field)
      ? { kind: field as FieldKind, target: null, optionKeys: [] }
      : null;
  }
  if (!isRecord(field)) return null;
  const type = field["type"];
  if (type === "ref" && typeof field["to"] === "string") return { kind: "ref", target: field["to"], optionKeys: [] };
  if (type === "list" && typeof field["of"] === "string") return { kind: "list", target: field["of"], optionKeys: [] };
  if (type === "enum" && isRecord(field["options"])) {
    const optionKeys = Object.keys(field["options"]);
    return optionKeys.length === 0 ? null : { kind: "enum", target: null, optionKeys };
  }
  return null;
}

/** 前の型が、後の型にそのまま入っているか。**種類と参照先は同じ**で、**選択肢のキーは足すのがよい**。 */
const keepsFieldShape = (previous: FieldShape, next: FieldShape): boolean =>
  previous.kind === next.kind &&
  previous.target === next.target &&
  previous.optionKeys.every((key) => next.optionKeys.includes(key));

/** R2 から読んだ正規化した JSON（`{schemaVersion, sourceSha256, spec}`）から、entity の並びを読む */
function readEntities(normalized: unknown): readonly unknown[] | null {
  if (!isRecord(normalized)) return null;
  const spec = normalized["spec"];
  if (!isRecord(spec) || !Array.isArray(spec["entities"])) return null;
  return spec["entities"];
}

/**
 * 前の原本の「正規化した JSON」から、**はっきり差し替えてよい宣言か**を決める
 * （#175 の追記1。窓口が決めた値）。
 *
 * 前の宣言にある entity と項目が、後の宣言にも**同じ名前で**要り、**型が変わっていなければ**よい。
 * **足すのはよい**（entity・項目・選択肢のキー）。**消す・型を変える・entity の名前を変えるのは断る**
 * ——保存済みのレコードの読み方を変えないためである（`packages/appspec-schema/docs/semantics.md`
 * 「宣言の差し替え」）。データ層（entity と項目）以外の宣言（`views`・`actions`・`validations`・
 * `computed`・`permissions`・`minIdentity`）は、ここでは見ない（差し替えてよい）。
 */
export function isReplaceableDeclaration(previousNormalized: unknown, next: AppSpec): boolean {
  const previousEntities = readEntities(previousNormalized);
  if (previousEntities === null) return false;
  const nextEntities = new Map(next.entities.map((entity) => [entity.name, entity]));
  return previousEntities.every((before) => {
    if (!isRecord(before) || typeof before["name"] !== "string") return false;
    const after = nextEntities.get(before["name"]);
    const fields = before["fields"];
    if (after === undefined || !isRecord(fields)) return false;
    return Object.entries(fields).every(([name, field]) => {
      const nextField = after.fields[name];
      if (nextField === undefined) return false;
      const previousShape = readFieldShape(field);
      const nextShape = readFieldShape(nextField);
      return previousShape !== null && nextShape !== null && keepsFieldShape(previousShape, nextShape);
    });
  });
}

// ── 差し替えの下調べ ────────────────────────────────────────────────

/** 下調べの結果。`replacing` は、差し替えるときの前の原本の SHA-256（差し替えないとき `null`）。 */
type ReplacementPlan =
  | { readonly ok: true; readonly replacing: string | null }
  | { readonly ok: false; readonly rejection: PublishRejection };

/** 差し替えを断る（**R2 にも D1 にも書かない**。登録簿の行は前のまま）。 */
const rejectReplacement = (message: string): ReplacementPlan => ({
  ok: false,
  rejection: reject("instance", message, [], "replacement_conflict"),
});

/**
 * 差し替えの下調べ（#175。`replace: true` のときだけ呼ぶ）。**読み取りだけで、何も書かない。**
 *
 * 前の参照（`app_instances` の行）と、前の原本の正規化した JSON（R2 の `normalized_key`）を読み、
 * 差し替えてよい宣言かを決める。**断ると分かった時点で止める**ので、R2 にも D1 にも書かない
 * （`instance_conflict` が R2 を書いた後で止まるのと違い、こちらは何も残さない）。
 */
async function planReplacement(
  deps: PublishDeps,
  instanceId: string,
  sourceSha256: string,
  next: AppSpec,
): Promise<ReplacementPlan> {
  try {
    const previous = await getInstance(deps.registry, instanceId);
    // インスタンスがまだ無い（新規）・同じ原本（同じ SHA-256）なら、差し替えるものは無い
    if (previous === null || previous.sourceSha256 === sourceSha256) return { ok: true, replacing: null };
    if (deps.readSpec === undefined) return rejectReplacement(REPLACEMENT_MESSAGES.reader);
    const previousApp = await getApp(deps.registry, previous.sourceSha256);
    if (previousApp === null) return rejectReplacement(REPLACEMENT_MESSAGES.previous);
    let previousNormalized: unknown;
    try {
      previousNormalized = await deps.readSpec.read(previousApp.normalizedKey);
    } catch {
      // 例外の文言は URL・Account ID・R2 のキーを含み得る。値を持たない説明にする
      return rejectReplacement(REPLACEMENT_MESSAGES.unreadable);
    }
    if (!isReplaceableDeclaration(previousNormalized, next)) {
      return rejectReplacement(REGISTRY_MESSAGES.replacement_conflict);
    }
    return { ok: true, replacing: previous.sourceSha256 };
  } catch (thrown) {
    // D1 の読み取りの失敗（想定外）。後ろの段を行わない
    return { ok: false, rejection: rejectRegistry("instance", thrown) };
  }
}

// ── 公開の入口 ────────────────────────────────────────────────────

/**
 * 宣言を検査し、正規化し、R2 に 2 個置き、D1 に登録する。
 *
 * **途中で落ちても成功を返さない。** 失敗は `failure.stage` でどの段かを示し、それより後ろの段は行わない。
 * 同じ入力で再実行すれば、正しい状態へ到達する（R2 の上書きと、D1 の冪等な登録）。
 *
 * `request.replace` が `true` のときは、既存インスタンスの参照先を**はっきり差し替える**（#175）。
 * 差し替えてよい宣言かは、前の原本の正規化した JSON と比べて決める（`isReplaceableDeclaration`）。
 *
 * 例外を外へ出さない（R2 と D1 の失敗は結果にする）。呼ぶ側（CLI）は、結果をそのまま安全に出せる。
 */
export async function publishSpec(deps: PublishDeps, request: PublishRequest): Promise<PublishResult> {
  // 1. 検査と正規化（spec-engine）。負例はここで止まり、R2 にも D1 にも触らない
  const normalized = await normalizeSpec(request.source);
  if (!normalized.ok) return reject("check", MESSAGES.check, normalized.diagnostics);

  const { schemaVersion, sourceSha256 } = normalized.app;
  const sourceKey = sourceObjectKey(sourceSha256);
  const normalizedKey = normalizedObjectKey(sourceSha256);

  // 2. 差し替えの下調べ（`replace: true` のときだけ。読み取りだけで、何も書かない）
  const plan =
    request.replace === true
      ? await planReplacement(deps, request.instanceId, sourceSha256, normalized.app.spec)
      : ({ ok: true, replacing: null } as const);
  if (!plan.ok) return plan.rejection;
  const replacing = plan.replacing;

  // 3. R2 の 1 個目（原本は受け取ったバイト列のまま）
  try {
    await deps.specs.write(sourceKey, request.source);
  } catch {
    return reject("source", MESSAGES.source);
  }
  // 4. R2 の 2 個目（正規化した JSON は #98 が作ったバイト列のまま）
  try {
    await deps.specs.write(normalizedKey, normalized.json);
  } catch {
    return reject("normalized", MESSAGES.normalized);
  }

  // 5. D1（アプリ → インスタンス）。R2 の 2 個が揃ってからでないと登録しない
  let app: AppRecord;
  try {
    app = await registerApp(deps.registry, { sourceSha256, schemaVersion, sourceKey, normalizedKey });
  } catch (thrown) {
    return rejectRegistry("app", thrown);
  }
  // 6. D1（インスタンス）。差し替えるときは、前の参照と一致する行だけを書き換える（compare-and-swap）
  let instance: AppInstanceRecord;
  try {
    instance =
      replacing === null
        ? await registerInstance(deps.registry, { instanceId: request.instanceId, sourceSha256 })
        : await replaceInstance(deps.registry, { instanceId: request.instanceId, sourceSha256 }, replacing);
  } catch (thrown) {
    return rejectRegistry("instance", thrown);
  }
  return { ok: true, app, instance, replacedSourceSha256: replacing };
}
