// 書けない要件の申告（v11a/unwritable-claims.ts）の unit テスト（Issue #807）。
//
// 抽象的な題材だけを使う（受入の題材の言葉を書かない）。文書の制約 ID は `### ` の見出しで、要件の文は
// 要件の番号だけを持つ。外部の採点の読み方（`unwritable[].text`・`quote`・部分を結んだ文に `keys` を当てる）と
// 最終判定の決め方を、このファイルの中で人工の定義に写して照らす（外の定義の文は写さない）。
import { describe, expect, it } from "vitest";
import type { UnwritableRequirement } from "../bundle.js";
import type { RequirementList } from "../pipeline.js";
import { expectNoAcceptanceMaterial } from "../stages/__tests__/prompt.js";
import type { PromptDocument } from "../stages/prompt.js";
import type { AcceptedPartBasis, AcceptedParts } from "../v12/accepted-parts.js";
import type { CarryOverEntry, CarryOverReason } from "./carry-over.js";
import { deriveUnwritableClaims, documentBasisOf } from "./carry-over.js";
import type { NameTable, NameTableVerification } from "./names.js";

const requirement = (id: string, text: string) => ({
  id,
  text,
  quote: `${text}の引用`,
  position: { start: 0, end: text.length },
});

/** 制約 ID を `### ` の見出しで持つ文書（列挙順は 甲・乙・丙） */
const DOCUMENTS: readonly PromptDocument[] = [
  { name: "第一の文書", text: "# 第一の文書\n\n### 甲\n\n甲の説明。\n\n### 乙\n\n乙の説明。\n" },
  { name: "第二の文書", text: "### 丙\n\n丙の説明。\n" },
];

const unresolved = (requirementId: string, constraintIds: readonly string[], reason = "書けない理由"): NameTableVerification => ({
  requirementId,
  kind: "unresolved",
  reason,
  constraintIds,
});
const fixed = (requirementId: string): NameTableVerification => ({ requirementId, kind: "fixed-test" });

const tableOf = (verification: readonly NameTableVerification[]): NameTable => ({
  rows: [],
  ownership: [],
  verification,
  classification: [],
});

const reason = (origin: CarryOverReason["origin"], text = "理由"): CarryOverReason => ({ origin, reason: text });
const entry = (requirementId: string, reasons: readonly CarryOverReason[]): CarryOverEntry => ({ requirementId, reasons });

describe("根拠の読み方（documentBasisOf）", () => {
  const ids = new Set(["甲", "乙", "丙"]);

  it("同じ ID を前後の空白・バッククォート・見出しの接頭辞で書いても、正規化した同じ並びになる", () => {
    expect(documentBasisOf(["  甲  "], ids)).toEqual(["甲"]);
    expect(documentBasisOf(["`甲`"], ids)).toEqual(["甲"]);
    expect(documentBasisOf(["### 甲"], ids)).toEqual(["甲"]);
    expect(documentBasisOf(["  `### 甲`  "], ids)).toEqual(["甲"]);
  });

  it("逆順・重複・表記揺れの混在でも、文書の集合の列挙順で返す", () => {
    expect(documentBasisOf(["乙", "甲"], ids)).toEqual(["甲", "乙"]);
    expect(documentBasisOf(["甲", "甲"], ids)).toEqual(["甲"]);
    expect(documentBasisOf(["`乙`", "  甲 "], ids)).toEqual(["甲", "乙"]);
  });

  it("文書の ID と未対応の観測 ID の混在・観測だけ・どちらにも無い ID・0 件は根拠にしない", () => {
    expect(documentBasisOf(["甲", "観測X"], new Set(["甲", "乙", "丙"]))).toBeNull();
    expect(documentBasisOf(["観測X"], ids)).toBeNull();
    expect(documentBasisOf(["未知"], ids)).toBeNull();
    expect(documentBasisOf([], ids)).toBeNull();
    expect(documentBasisOf(["   ", "``"], ids)).toBeNull();
  });
});

describe("申告の導出（deriveUnwritableClaims）", () => {
  // 12 の台本。申告になるのは「根拠 1 件」「根拠 2 件」「部分が混在」「accepted_unwritable に無い」「parts が空」の 5 件だけ。
  const list: RequirementList = {
    requirements: [
      requirement("R01", "要件の文 01。"),
      requirement("R02", "要件の文 02。"),
      requirement("R03", "要件の文 03。"),
      requirement("R04", "要件の文 04。"),
      requirement("R05", "要件の文 05。"),
      requirement("R06", "要件の文 06。"),
      requirement("R07", "要件の文 07。"),
      requirement("R08", "要件の文 08。"),
      requirement("R09", "要件の文 09。"),
      requirement("R10", "要件の文 10。"),
      requirement("R11", "要件の文 11。"),
      requirement("R12", "要件の文 12。"),
    ],
    decisions: [],
    unresolved: [],
  };
  const table = tableOf([
    unresolved("R01", ["甲"]),
    unresolved("R02", ["甲", "乙"]),
    unresolved("R03", ["甲", "観測X"]),
    fixed("R04"),
    fixed("R05"),
    fixed("R06"),
    { requirementId: "R07", kind: "non-requirement" },
    unresolved("R08", ["甲"]),
    unresolved("R09", ["乙"]),
    unresolved("R10", ["丙"]),
    unresolved("R11", ["甲"]),
    unresolved("R12", ["p12"]),
  ]);
  const entries: readonly CarryOverEntry[] = [
    entry("R01", [reason("name-table")]),
    entry("R02", [reason("name-table")]),
    entry("R03", [reason("name-table")]),
    entry("R04", [reason("semantic-check")]),
    entry("R05", [reason("decl-check")]),
    entry("R06", [reason("coverage")]),
    // 要件でない文（T1'' が受理した）は持ち越しに入らないので、ここには現れない
    entry("R08", [reason("name-table")]),
    // 部分が混在（了承済みと未了承）。出どころも name-table と semantic-check の混在でもある
    entry("R09", [reason("name-table"), reason("semantic-check")]),
    // accepted_removal だが accepted_unwritable に無い（部分はあるが了承済みの集合は空）
    entry("R10", [reason("name-table")]),
    // parts が空
    entry("R11", [reason("name-table")]),
    // 了承済みの部分 ID の根拠
    entry("R12", [reason("name-table")]),
  ];
  const acceptedPartBasis: AcceptedPartBasis = {
    anyPartIds: new Set(["p8", "p9a", "p9b", "p10", "p12"]),
    byRequirement: new Map([
      ["R08", { allAccepted: true, acceptedPartIds: new Set(["p8"]), partIds: new Set(["p8"]) }],
      ["R09", { allAccepted: false, acceptedPartIds: new Set(["p9a"]), partIds: new Set(["p9a", "p9b"]) }],
      ["R10", { allAccepted: false, acceptedPartIds: new Set<string>(), partIds: new Set(["p10"]) }],
      ["R11", { allAccepted: false, acceptedPartIds: new Set<string>(), partIds: new Set<string>() }],
      ["R12", { allAccepted: false, acceptedPartIds: new Set<string>(), partIds: new Set(["p12"]) }],
    ]),
  };
  const acceptedParts: AcceptedParts = { requirements: [], allAcceptedRequirementIds: [], basis: acceptedPartBasis };
  const derive = () =>
    deriveUnwritableClaims({ list, table, documents: DOCUMENTS, entries, acceptedParts });

  it("申告は 5 件だけ（根拠 1 件・2 件・部分が混在・accepted_unwritable に無い・parts が空）で、一覧の順", () => {
    expect(derive().map((claim) => claim.requirementId)).toEqual(["R01", "R02", "R09", "R10", "R11"]);
  });

  it("申告と了承済みの持ち越しは重ならない（R12 は了承済みの部分 ID の根拠なので申告にしない）", () => {
    const claims = derive();
    expect(claims.some((claim) => claim.requirementId === "R12")).toBe(false);
  });

  it("形：要件 ID・文・引用は有効な一覧と一致し、部分は 1 件で末尾に「（根拠: …）」を添える", () => {
    const claim = derive()[1] as UnwritableRequirement;
    expect(claim).toEqual({
      requirementId: "R02",
      text: "要件の文 02。",
      quote: "要件の文 02。の引用",
      unwritable: ["書けない理由（根拠: 甲・乙）"],
    });
    for (const item of derive()) expect(item.unwritable).toHaveLength(1);
  });

  it("base（直す前の挙動）は申告 0 件：出どころが name-table でない・根拠が文書でない要件は写さない", () => {
    // 直す前の配線は納品物に空の申告を固定で渡していた（`unwritable: []`）。その値（空）を基準として残す
    const before: readonly UnwritableRequirement[] = [];
    expect(before).toEqual([]);
    const excluded = derive().map((claim) => claim.requirementId);
    expect(excluded).not.toContain("R03");
    expect(excluded).not.toContain("R04");
    expect(excluded).not.toContain("R05");
    expect(excluded).not.toContain("R06");
    expect(excluded).not.toContain("R08");
  });
});

// ── (1)(2) 了承済みの持ち越しを申告に写す（Issue #847）────────────────────────

describe("(1) 申告の導出：了承済みの持ち越しを申告に写し、反例 (a)(b)(c) は写さない（Issue #847）", () => {
  const list: RequirementList = {
    requirements: [
      requirement("R01", "要件の文 01。"),
      requirement("R02", "要件の文 02。"),
      requirement("R03", "要件の文 03。"),
      requirement("R04", "要件の文 04。"),
      requirement("R05", "要件の文 05。"),
      requirement("R06", "要件の文 06。"),
    ],
    decisions: [],
    unresolved: [],
  };
  const table = tableOf([
    // 1. 全部が了承済みの要件で、根拠がその部分 ID
    unresolved("R01", ["p1"]),
    // 2. 文書の根拠 1 件
    unresolved("R02", ["甲"]),
    // 3. 文書の根拠で、部分が混在（了承済みと未了承）
    unresolved("R03", ["甲"]),
    // 4. 全部が了承済みの要件で、根拠が文書の ID（反例 (c)）
    unresolved("R04", ["甲"]),
    // 5. 全部が了承済みの要件で、C3 の拒否（反例 (a)。出どころが semantic-check）
    fixed("R05"),
    // 6. 部分 ID と文書の ID が同じ文字列の全部が了承済みの要件（反例 (b)）
    unresolved("R06", ["甲"]),
  ]);
  const entries: readonly CarryOverEntry[] = [
    entry("R01", [reason("name-table")]),
    entry("R02", [reason("name-table")]),
    entry("R03", [reason("name-table"), reason("semantic-check")]),
    entry("R04", [reason("name-table")]),
    entry("R05", [reason("semantic-check")]),
    entry("R06", [reason("name-table")]),
  ];
  const acceptedParts: AcceptedParts = {
    requirements: [
      { requirementId: "R01", acceptedPartIds: ["p1"], allAccepted: true, parts: [{ requirementId: "R01", partId: "p1", text: "了承した部分 01。" }] },
      { requirementId: "R03", acceptedPartIds: ["p3"], allAccepted: false, parts: [{ requirementId: "R03", partId: "p3", text: "了承した部分 03。" }] },
      { requirementId: "R04", acceptedPartIds: ["p4"], allAccepted: true, parts: [{ requirementId: "R04", partId: "p4", text: "了承した部分 04。" }] },
      { requirementId: "R05", acceptedPartIds: ["p5"], allAccepted: true, parts: [{ requirementId: "R05", partId: "p5", text: "了承した部分 05。" }] },
      { requirementId: "R06", acceptedPartIds: ["甲"], allAccepted: true, parts: [{ requirementId: "R06", partId: "甲", text: "了承した部分 06。" }] },
    ],
    allAcceptedRequirementIds: ["R01", "R04", "R05", "R06"],
    basis: {
      anyPartIds: new Set(["p1", "p3", "p4", "p5", "甲"]),
      byRequirement: new Map([
        ["R01", { allAccepted: true, acceptedPartIds: new Set(["p1"]), partIds: new Set(["p1"]) }],
        ["R03", { allAccepted: false, acceptedPartIds: new Set(["p3"]), partIds: new Set(["p3", "p3b"]) }],
        ["R04", { allAccepted: true, acceptedPartIds: new Set(["p4"]), partIds: new Set(["p4"]) }],
        ["R05", { allAccepted: true, acceptedPartIds: new Set(["p5"]), partIds: new Set(["p5"]) }],
        ["R06", { allAccepted: true, acceptedPartIds: new Set(["甲"]), partIds: new Set(["甲"]) }],
      ]),
    },
  };
  // #841 の導出の結果（導き直さない）。R04 は文書の ID の根拠・R05 は semantic-check・R06 は文書との衝突なので入らない
  const acceptedCarried = ["R01"];
  const derive = () =>
    deriveUnwritableClaims({ list, table, documents: DOCUMENTS, entries, acceptedParts, acceptedCarried });

  it("(1) 申告は 1・2・3 の 3 件だけ、一覧の順。4（反例 (c)）・5（反例 (a)）・6（反例 (b)）は申告にしない", () => {
    expect(derive().map((claim) => claim.requirementId)).toEqual(["R01", "R02", "R03"]);
  });

  it("(1) base（了承済みの持ち越しを写さない）は 1 を申告しない（赤）", () => {
    const before = deriveUnwritableClaims({ list, table, documents: DOCUMENTS, entries, acceptedParts });
    expect(before.map((claim) => claim.requirementId)).toEqual(["R02", "R03"]);
    expect(before.map((claim) => claim.requirementId)).not.toContain("R01");
  });

  it("(1) 4・5・6 は、了承済みに数える条件を満たさないので申告に足さない（反例を残す）", () => {
    const ids = derive().map((claim) => claim.requirementId);
    // (c) 全部が了承済みで根拠が文書の ID：文書の根拠の規則が全部が了承済みの要件を外す
    expect(ids).not.toContain("R04");
    // (a) C3 の拒否：出どころが semantic-check だけなので name-table の規則にも了承済みにも当たらない
    expect(ids).not.toContain("R05");
    // (b) 部分 ID と文書の ID が同じ文字列：了承済みに入らず、全部が了承済みなので文書の規則も外す
    expect(ids).not.toContain("R06");
  });
});

describe("(2) 了承済みの申告の形（Issue #847）", () => {
  const list: RequirementList = {
    requirements: [requirement("R1", "要件の文 01。")],
    decisions: [],
    unresolved: [],
  };
  const twoParts: AcceptedParts = {
    requirements: [
      {
        requirementId: "R1",
        acceptedPartIds: ["a", "b"],
        allAccepted: true,
        parts: [
          { requirementId: "R1", partId: "a", text: "確定した仕様の部分 A。" },
          { requirementId: "R1", partId: "b", text: "確定した仕様の部分 B。" },
        ],
      },
    ],
    allAcceptedRequirementIds: ["R1"],
    basis: {
      anyPartIds: new Set(["a", "b"]),
      byRequirement: new Map([["R1", { allAccepted: true, acceptedPartIds: new Set(["a", "b"]), partIds: new Set(["a", "b"]) }]]),
    },
  };
  const deriveWith = (constraintIds: readonly string[]) =>
    deriveUnwritableClaims({
      list,
      table: tableOf([unresolved("R1", constraintIds)]),
      documents: DOCUMENTS,
      entries: [entry("R1", [reason("name-table")])],
      acceptedParts: twoParts,
      acceptedCarried: ["R1"],
    })[0] as UnwritableRequirement;

  it("部分は確定した仕様の部分の文 2 行で、parts の順・文字列が一致する。C2 の理由・根拠の ID を含まない", () => {
    const claim = deriveWith(["a"]);
    expect(claim).toEqual({
      requirementId: "R1",
      text: "要件の文 01。",
      quote: "要件の文 01。の引用",
      unwritable: ["確定した仕様の部分 A。", "確定した仕様の部分 B。"],
    });
    for (const part of claim.unwritable) {
      expect(part).not.toContain("根拠:");
      expect(part).not.toContain("宣言で書けない");
    }
  });

  it("C2 が根拠を表記揺れ・重複・逆順で挙げても同じ申告になる", () => {
    const plain = deriveWith(["a", "b"]);
    expect(deriveWith(["  `a`  ", "b", "a"])).toEqual(plain);
    expect(deriveWith(["b", "a"])).toEqual(plain);
  });

  it("v1 の数え方（部分の文の一致）に掛けると了承済みに数えられる", () => {
    const claim = deriveWith(["a"]);
    const acceptedTexts = twoParts.requirements[0]?.parts.map((part) => part.text) ?? [];
    const v1Accepted = claim.unwritable.length > 0 && claim.unwritable.every((part) => acceptedTexts.includes(part));
    expect(v1Accepted).toBe(true);
    // 部分の文を 1 行でも変えれば、v1 の数え方では了承済みにならない（数え方が空回りしていない）
    const broken = { ...claim, unwritable: ["別の文。", ...claim.unwritable.slice(1)] };
    expect(broken.unwritable.every((part) => acceptedTexts.includes(part))).toBe(false);
  });
});

// ── 外の採点との照合（人工の定義。Issue #807 の完了条件 (7)・#847 の (5)）────────────────────
//
// 外の採点の実際の読み方（`workspace/mvp/m1/agent/eval/score-agent.mjs` の写し）：
//   - 申告は**部分ごと**に「要件の文（引用） 部分」の文に展開して採点する（`unwritable[]` の行ごとに 1 件）
//   - 期待の書けない要件の `keys` は、**どれか一つ**が申告の文に当たれば一致（部分一致の正規表現）
//   - 期待に当たれば correct、当たらなければ missed。許される申告に当たれば allowed、どれにも当たらなければ false_claims
// 最終判定：`PASS_NEEDS_CLAIM` の本は missed 0 で PASS・1 以上で FAIL。PASS・FAIL の本は申告で変わらない。

interface ClaimKeys {
  readonly id: string;
  readonly keys: readonly string[];
}
interface ClaimDefinition {
  readonly unwritable: readonly ClaimKeys[];
  readonly allowedClaims?: readonly ClaimKeys[];
}

/** 申告 1 件を、外の採点と同じ**部分ごと**の文に展開する（`${要件の文}（${引用}） ${部分}`） */
const claimTextsOf = (claim: UnwritableRequirement): readonly string[] =>
  claim.unwritable.map((part) => `${claim.text}（${claim.quote}） ${part}`);

/** 鍵の**どれか一つ**が当たれば一致（外の採点の `hit`） */
const hits = (keys: readonly string[], text: string): boolean => keys.some((key) => new RegExp(key).test(text));

function scoreClaims(claims: readonly UnwritableRequirement[], definition: ClaimDefinition) {
  const texts = claims.flatMap(claimTextsOf);
  const expected = definition.unwritable;
  const allowed = definition.allowedClaims ?? [];
  const correct = expected.filter((u) => texts.some((text) => hits(u.keys, text))).length;
  const missed = expected.length - correct;
  let allowedCount = 0;
  const falseClaims: string[] = [];
  for (const text of texts) {
    if (expected.some((u) => hits(u.keys, text))) continue;
    if (allowed.some((u) => hits(u.keys, text))) allowedCount += 1;
    else falseClaims.push(text);
  }
  return { correct, missed, allowed: allowedCount, false_claims: falseClaims };
}

/**
 * 直す前の写し（Issue #807 の (7)）：申告を 1 件にまとめ、鍵を**全部**当てる。この写しは実際の外の照合と
 * ずれており、(5) の 2 つの人工例で不一致・隠れを起こす（赤）。
 */
function scoreClaimsBefore847(claims: readonly UnwritableRequirement[], definition: ClaimDefinition) {
  const haystack = (claim: UnwritableRequirement): string => [claim.text, claim.quote, claim.unwritable.join(" ")].join("\n");
  const every = (keys: readonly string[], text: string): boolean => keys.every((key) => new RegExp(key).test(text));
  const expected = definition.unwritable;
  const allowed = definition.allowedClaims ?? [];
  const correct = expected.filter((u) => claims.some((claim) => every(u.keys, haystack(claim)))).length;
  let allowedCount = 0;
  const falseClaims: string[] = [];
  for (const claim of claims) {
    if (expected.some((u) => every(u.keys, haystack(claim)))) continue;
    if (allowed.some((u) => every(u.keys, haystack(claim)))) allowedCount += 1;
    else falseClaims.push(haystack(claim));
  }
  return { correct, missed: expected.length - correct, allowed: allowedCount, false_claims: falseClaims };
}

const finalVerdict = (spec: { readonly verdict: string }, claims: { readonly missed: number } | null): string =>
  spec.verdict === "PASS_NEEDS_CLAIM" ? (claims !== null && claims.missed === 0 ? "PASS" : "FAIL") : spec.verdict;

const claimOf = (requirementId: string, text: string, parts: readonly string[]): UnwritableRequirement => ({
  requirementId,
  text,
  quote: `${text}の引用`,
  unwritable: parts,
});

describe("(5) 外の採点との照合を実際の外の照合にそろえる（人工の例。API 不要）", () => {
  it("複数の鍵のうち一つだけ一致：今の写しは当たり、直す前の写しは当たらない（赤）", () => {
    const definition: ClaimDefinition = { unwritable: [{ id: "U1", keys: ["甲", "乙"] }] };
    const claims = [claimOf("R1", "要件の文 01。", ["根拠は甲である。"])];
    // 今の写し：鍵はどれか一つで一致
    expect(scoreClaims(claims, definition)).toMatchObject({ correct: 1, missed: 0, false_claims: [] });
    // 直す前の写し：鍵を全部当てるので一致しない
    expect(scoreClaimsBefore847(claims, definition)).toMatchObject({ correct: 0, missed: 1 });
  });

  it("二部分のうち一方だけが定義に当たる：今の写しは片方を false_claims にし、直す前の写しは隠す（赤）", () => {
    const definition: ClaimDefinition = { unwritable: [{ id: "U1", keys: ["定義に当たる"] }] };
    const claims = [claimOf("R1", "要件の文 01。", ["定義に当たる部分。", "当たらない部分。"])];
    const scored = scoreClaims(claims, definition);
    expect(scored.correct).toBe(1);
    expect(scored.false_claims).toHaveLength(1);
    expect(scored.false_claims[0]).toContain("当たらない部分。");
    // 部分ごとに展開しない写しは、当たらない部分を false_claims に挙げない（隠れる）
    expect(scoreClaimsBefore847(claims, definition).false_claims).toHaveLength(0);
  });

  it("了承済みの申告は、鍵が要件の文だけに当たる定義でも、部分の文だけに当たる定義でも correct になり、挙げ漏れが 1 から 0 になる（base は missed＝赤）", () => {
    const accepted = [claimOf("R1", "要件の文 01。", ["確定した仕様の部分 A。", "確定した仕様の部分 B。"])];
    const byRequirement: ClaimDefinition = { unwritable: [{ id: "U1", keys: ["要件の文 01。"] }] };
    const byPart: ClaimDefinition = { unwritable: [{ id: "U1", keys: ["部分 A"] }] };
    for (const definition of [byRequirement, byPart]) {
      expect(scoreClaims(accepted, definition)).toMatchObject({ correct: 1, missed: 0 });
      // base（了承済みの持ち越しを申告に写さなかった）は挙げ漏れ 1
      expect(scoreClaims([], definition).missed).toBe(1);
    }
  });

  it("どの定義にも当たらない了承済みの申告は false_claims になる（反例 (d) を残す）", () => {
    const definition: ClaimDefinition = { unwritable: [{ id: "U1", keys: ["別の要件の文"] }] };
    const claim = claimOf("R1", "要件の文 01。", ["どの定義にも当たらない部分。"]);
    const scored = scoreClaims([claim], definition);
    expect(scored.correct).toBe(0);
    expect(scored.missed).toBe(1);
    expect(scored.false_claims).toHaveLength(1);
    expect(scored.false_claims[0]).toContain("どの定義にも当たらない部分。");
  });

  it("correct・missed・allowed・false_claims に分かれる", () => {
    const definition: ClaimDefinition = {
      unwritable: [
        { id: "U1", keys: ["根拠: 甲"] },
        { id: "U2", keys: ["根拠: 乙"] },
      ],
      allowedClaims: [{ id: "A1", keys: ["許される"] }],
    };
    const claims = [
      claimOf("R1", "要件の文 01。", ["書けない（根拠: 甲）"]),
      claimOf("R2", "要件の文 02。", ["書けない（根拠: 乙）"]),
      claimOf("R3", "要件の文 03。", ["許される申告"]),
      claimOf("R4", "要件の文 04。", ["当たらない申告"]),
    ];
    const scored = scoreClaims(claims, definition);
    expect(scored).toEqual({ correct: 2, missed: 0, allowed: 1, false_claims: [claimTextsOf(claims[3] as UnwritableRequirement)[0]] });
    // 別の要件の文（text）だけでも当たる（照合の文は text・quote を含む）
    const byText = scoreClaims([claimOf("R5", "根拠: 甲 を含む文。", ["当たらない"])], definition);
    expect(byText.correct).toBe(1);
  });

  it("PASS_NEEDS_CLAIM の本は missed 0 で PASS・1 以上で FAIL", () => {
    const definition: ClaimDefinition = {
      unwritable: [
        { id: "U1", keys: ["根拠: 甲"] },
        { id: "U2", keys: ["根拠: 乙"] },
      ],
    };
    const complete = scoreClaims([claimOf("R1", "要件の文 01。", ["書けない（根拠: 甲）"]), claimOf("R2", "要件の文 02。", ["書けない（根拠: 乙）"])], definition);
    expect(complete.missed).toBe(0);
    expect(finalVerdict({ verdict: "PASS_NEEDS_CLAIM" }, complete)).toBe("PASS");
    const partial = scoreClaims([claimOf("R1", "要件の文 01。", ["書けない（根拠: 甲）"])], definition);
    expect(partial.missed).toBe(1);
    expect(finalVerdict({ verdict: "PASS_NEEDS_CLAIM" }, partial)).toBe("FAIL");
  });

  it("PASS・FAIL の本は申告で変わらない", () => {
    const complete = { missed: 0 };
    const partial = { missed: 1 };
    expect(finalVerdict({ verdict: "PASS" }, complete)).toBe("PASS");
    expect(finalVerdict({ verdict: "PASS" }, partial)).toBe("PASS");
    expect(finalVerdict({ verdict: "FAIL" }, complete)).toBe("FAIL");
    expect(finalVerdict({ verdict: "FAIL" }, partial)).toBe("FAIL");
    expect(finalVerdict({ verdict: "STATIC_NG" }, null)).toBe("STATIC_NG");
  });
});

// ── 題材の言葉の走査（Issue #807）────────────────────────────────────────
//
// 要求・試験・fixture のどこにも受入の題材の言葉を書かない。cli.test.ts は走査の語の並びを持つので除く
// （他の走査の試験と同じ扱い）。

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

describe("題材の言葉の走査（Issue #807 で足した・直したファイル）", () => {
  it("carry-over・run・bundle-v11a とその試験に受入の題材の言葉が無い", () => {
    const files = [
      "./carry-over.ts",
      "./carry-over.test.ts",
      "./run.ts",
      "./run.test.ts",
      "./bundle-v11a.ts",
      "./bundle-v11a.test.ts",
      "./unwritable-claims.test.ts",
    ];
    expectNoAcceptanceMaterial(files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
