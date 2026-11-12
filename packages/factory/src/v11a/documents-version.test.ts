// Issue #875（原因 2）：段の再開の版の照合は語彙・契約の版の名前と台帳の指紋だけを照らし、文書の中身を照らさなかった。
// 段へ渡す文書の中身の指紋 `documentsVersionOf` をパッケージの入口から出す（計測の道具が各 checkout の文書から期待値を作る）。
//
// 二点測定：同じ文書で同じ値、名前か本文の 1 文字の違い・並びの違いで違う値。偽物も外部の API も使わない。

import { sha256Hex } from "@musunest/spec-engine";
import { describe, expect, it } from "vitest";
import * as factory from "../index.js";
import { FIXTURE_DOCUMENTS } from "./__tests__/fixtures.js";
import { documentsVersionOf } from "./bundle-v11a.js";

describe("documentsVersionOf（段へ渡す文書の中身の指紋。Issue #875）", () => {
  it("パッケージの入口から呼べ、段の版のモジュールの関数と同じもの", () => {
    expect(factory.documentsVersionOf).toBe(documentsVersionOf);
  });

  it("64 桁の 16 進で、同じ文書（別の値の写し）で同じ値", async () => {
    const value = await factory.documentsVersionOf(FIXTURE_DOCUMENTS);
    expect(value).toMatch(/^[0-9a-f]{64}$/u);
    const copy = FIXTURE_DOCUMENTS.map((document) => ({ name: `${document.name}`, text: `${document.text}` }));
    expect(await factory.documentsVersionOf(copy)).toBe(value);
    expect(await factory.documentsVersionOf(FIXTURE_DOCUMENTS)).toBe(value);
  });

  it("二点測定：名前か本文の 1 文字の違い、並びの違い、文書の足し引きで違う値", async () => {
    // 並びの違いを見るため、文書を 2 つにする
    const base = [...FIXTURE_DOCUMENTS, { name: "second", text: "二つ目の文書" }];
    const value = await documentsVersionOf(base);
    const changedAt = (index: number, change: (document: { name: string; text: string }) => { name: string; text: string }) =>
      base.map((document, at) => (at === index ? change({ ...document }) : document));
    const variants = [
      changedAt(0, (document) => ({ ...document, text: `${document.text}字` })),
      changedAt(0, (document) => ({ ...document, text: document.text.slice(1) })),
      changedAt(1, (document) => ({ ...document, name: `${document.name}字` })),
      [...base.slice(1), ...base.slice(0, 1)],
      base.slice(1),
      [...base, { name: "extra", text: "" }],
    ];
    const values = await Promise.all(variants.map((documents) => documentsVersionOf(documents)));
    for (const [index, other] of values.entries()) expect(other, String(index)).not.toBe(value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("名前と本文の境目をずらしても同じ値にならない（連結ではなく欄ごとに正規化する）", async () => {
    const left = await documentsVersionOf([{ name: "ab", text: "c" }]);
    const right = await documentsVersionOf([{ name: "a", text: "bc" }]);
    expect(left).not.toBe(right);
    // 正規の形：名前と本文だけを持つ写像の並びの正規化した JSON の SHA-256（ほかの欄は読まない）
    expect(left).toBe(await sha256Hex('[{"name":"ab","text":"c"}]'));
    const withExtra = [{ name: "ab", text: "c", other: 1 }] as unknown as Parameters<typeof documentsVersionOf>[0];
    expect(await documentsVersionOf(withExtra)).toBe(left);
  });
});
