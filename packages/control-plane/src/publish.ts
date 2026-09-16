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
// D1 を実際に触るのは data-api だけである（CLAUDE.md 不変条件）。ここは SQL を書かず、注入された
// RegistryExecutor に任せる（src/contract.ts）。R2 も同じで、書き込みは注入された SpecWriter が行う。

import type { Diagnostic } from "@musunest/spec-engine";
import { normalizeSpec } from "@musunest/spec-engine";
import {
  RegistryError,
  type AppInstanceRecord,
  type AppRecord,
  type RegistryErrorCode,
  type RegistryExecutor,
} from "./contract.js";
import { registerApp, registerInstance } from "./registry.js";

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

// ── 入力と結果 ────────────────────────────────────────────────────

export interface PublishRequest {
  /** 原本（app.spec.yaml）のバイト列を、UTF-8 の文字列として受け取る。改行もコメントもそのまま */
  readonly source: string;
  /** 宣言を使うインスタンスの ID */
  readonly instanceId: string;
}

export interface PublishDeps {
  /** R2（原本と正規化した JSON） */
  readonly specs: SpecWriter;
  /** D1（登録表）。SQL と束縛は registry が持ち、実行だけを任せる */
  readonly registry: RegistryExecutor;
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
} as const satisfies Record<RegistryErrorCode, string>;

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

// ── 公開の入口 ────────────────────────────────────────────────────

/**
 * 宣言を検査し、正規化し、R2 に 2 個置き、D1 に登録する。
 *
 * **途中で落ちても成功を返さない。** 失敗は `failure.stage` でどの段かを示し、それより後ろの段は行わない。
 * 同じ入力で再実行すれば、正しい状態へ到達する（R2 の上書きと、D1 の冪等な登録）。
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

  // 2. R2 の 1 個目（原本は受け取ったバイト列のまま）
  try {
    await deps.specs.write(sourceKey, request.source);
  } catch {
    return reject("source", MESSAGES.source);
  }
  // 3. R2 の 2 個目（正規化した JSON は #98 が作ったバイト列のまま）
  try {
    await deps.specs.write(normalizedKey, normalized.json);
  } catch {
    return reject("normalized", MESSAGES.normalized);
  }

  // 4. D1（アプリ → インスタンス）。R2 の 2 個が揃ってからでないと登録しない
  let app: AppRecord;
  try {
    app = await registerApp(deps.registry, { sourceSha256, schemaVersion, sourceKey, normalizedKey });
  } catch (thrown) {
    return rejectRegistry("app", thrown);
  }
  let instance: AppInstanceRecord;
  try {
    instance = await registerInstance(deps.registry, { instanceId: request.instanceId, sourceSha256 });
  } catch (thrown) {
    return rejectRegistry("instance", thrown);
  }
  return { ok: true, app, instance };
}
