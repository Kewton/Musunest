// 宣言（app.spec.yaml）を、正規化した JSON に変換する（Issue #98）。
// 決めごとは workspace/mvp/m1/00-open-questions.md Q12 と、workspace/mvp/m1/04-spec-evolution.md §3。
//
// publish の時点で、静的チェック（check.ts）を通った宣言だけを NormalizedAppSpec にする。data-api と
// 画面はこの JSON だけを読み、**実行のたびに YAML の解析と静的チェックを繰り返さない**（CPU 10 ms。Q12）。
//
// ここで守る規約（README「正規化した JSON」）:
//   1. **検査に 1 つでも通らなければ、正規化した成果物を返さない**（診断だけを返す）。判定は check.ts の
//      1 か所だけに置く（publish と CI で判定がずれないように）
//   2. **同じ原本からは同じバイト列**を作る。現在時刻・乱数・環境の情報を混ぜない
//   3. **宣言の順を並べ替えない。** entity の項目順、view・computed・validation・action の宣言順は
//      意味を持つ（一覧の列の順・検査を返す順。docs/semantics.md）
//   4. `sourceSha256` は**原本そのもの**（改行とコメントを含む UTF-8 のバイト列）の SHA-256。
//      小文字の 16 進 64 桁
//   5. 出力は UTF-8・改行は LF・字下げは 2 文字・末尾に改行 1 つ（README に固定する）
//
// **YAML を読み直さない。** check.ts が読んだ型検査済みの AppSpec をそのまま入れる（読み取りが 2 か所に
// 分かれると、検査を通った宣言と正規化した宣言が食い違う）。

import { APPSPEC_SCHEMA_VERSION, type NormalizedAppSpec } from "@musunest/appspec-schema";
import { checkSpec } from "./check.js";
import type { Diagnostic } from "./diagnostics.js";

/** 正規化した JSON の字下げ（この文字数で固定する） */
export const NORMALIZED_JSON_INDENT = 2;

/**
 * 正規化の結果。成功は正規化した成果物（`app` と、その JSON の `json`）、
 * 失敗は #97 の診断（**成果物を返さない**）。
 */
export type NormalizeResult =
  | {
      readonly ok: true;
      readonly app: NormalizedAppSpec;
      /** 正規化した JSON の本文（末尾に改行 1 つ。UTF-8 で書けばこの文字列のバイト列である） */
      readonly json: string;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const encoder = new TextEncoder();

/**
 * 文字列の UTF-8 バイト列の SHA-256（小文字の 16 進 64 桁）。
 * `crypto.subtle` を使うので、Node でも Workers でも動く（依存を増やさない）。
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 正規化した JSON の本文にする。**同じ成果物からは同じバイト列**になる（規約 2・3・5）。
 * キーの並べ替えをしないので、宣言の順がそのまま残る。
 */
export function serializeNormalizedAppSpec(app: NormalizedAppSpec): string {
  return `${JSON.stringify(app, null, NORMALIZED_JSON_INDENT)}\n`;
}

/**
 * 原本（YAML の原文）を検査し、通ったものだけを正規化した JSON にする。
 *
 * **検査に通らない原本は正規化しない**（#97 の負例。規約 1）。原本のバイト列は、渡された文字列を
 * UTF-8 にしたものである——読み取りの改行の正規化（CRLF → LF）をここで行わない。
 */
export async function normalizeSpec(source: string): Promise<NormalizeResult> {
  const checked = checkSpec(source);
  if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics };
  const app: NormalizedAppSpec = {
    schemaVersion: APPSPEC_SCHEMA_VERSION,
    sourceSha256: await sha256Hex(source),
    spec: checked.spec,
  };
  return { ok: true, app, json: serializeNormalizedAppSpec(app), diagnostics: [] };
}
