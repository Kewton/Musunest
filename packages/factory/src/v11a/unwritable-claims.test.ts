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
import type { AcceptedPartBasis } from "../v12/accepted-parts.js";
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
  const acceptedParts: AcceptedPartBasis = {
    anyPartIds: new Set(["p8", "p9a", "p9b", "p10", "p12"]),
    byRequirement: new Map([
      ["R08", { allAccepted: true, acceptedPartIds: new Set(["p8"]), partIds: new Set(["p8"]) }],
      ["R09", { allAccepted: false, acceptedPartIds: new Set(["p9a"]), partIds: new Set(["p9a", "p9b"]) }],
      ["R10", { allAccepted: false, acceptedPartIds: new Set<string>(), partIds: new Set(["p10"]) }],
      ["R11", { allAccepted: false, acceptedPartIds: new Set<string>(), partIds: new Set<string>() }],
      ["R12", { allAccepted: false, acceptedPartIds: new Set<string>(), partIds: new Set(["p12"]) }],
    ]),
  };
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

// ── 外の採点との照合（人工の定義。Issue #807 の完了条件 (7)）────────────────────────────
//
// 外の申告の読み方：`unwritable[].text`・`quote`・部分を結んだ文に `keys` を正規表現として当てる。期待の書けない
// 要件に当たれば correct、当たらなければ missed。期待にも許される申告にも当たらないものは false_claims。
// 最終判定：`PASS_NEEDS_CLAIM` の本は missed 0 で PASS・1 以上で FAIL。PASS・FAIL の本は申告で変わらない。

interface ClaimKeys {
  readonly id: string;
  readonly keys: readonly string[];
}
interface ClaimDefinition {
  readonly unwritable: readonly ClaimKeys[];
  readonly allowedClaims?: readonly ClaimKeys[];
}

/** 申告 1 件の照合の文（text・quote・部分を結んだ文） */
const haystackOf = (claim: UnwritableRequirement): string =>
  [claim.text, claim.quote, claim.unwritable.join(" ")].join("\n");

const hits = (keys: readonly string[], text: string): boolean => keys.every((key) => new RegExp(key).test(text));

function scoreClaims(claims: readonly UnwritableRequirement[], definition: ClaimDefinition) {
  const expected = definition.unwritable;
  const allowed = definition.allowedClaims ?? [];
  const correct = expected.filter((u) => claims.some((claim) => hits(u.keys, haystackOf(claim)))).length;
  const missed = expected.length - correct;
  let allowedCount = 0;
  const falseClaims: string[] = [];
  for (const claim of claims) {
    if (expected.some((u) => hits(u.keys, haystackOf(claim)))) continue;
    if (allowed.some((u) => hits(u.keys, haystackOf(claim)))) allowedCount += 1;
    else falseClaims.push(haystackOf(claim));
  }
  return { correct, missed, allowed: allowedCount, false_claims: falseClaims };
}

const finalVerdict = (spec: { readonly verdict: string }, claims: { readonly missed: number } | null): string =>
  spec.verdict === "PASS_NEEDS_CLAIM" ? (claims !== null && claims.missed === 0 ? "PASS" : "FAIL") : spec.verdict;

const claimOf = (requirementId: string, text: string, part: string): UnwritableRequirement => ({
  requirementId,
  text,
  quote: `${text}の引用`,
  unwritable: [part],
});

describe("外の採点との照合（人工の定義。API 不要）", () => {
  const definition: ClaimDefinition = {
    unwritable: [
      { id: "U1", keys: ["根拠: 甲"] },
      { id: "U2", keys: ["根拠: 乙"] },
    ],
    allowedClaims: [{ id: "A1", keys: ["許される"] }],
  };

  it("correct・missed・allowed・false_claims に分かれる", () => {
    const claims = [
      claimOf("R1", "要件の文 01。", "書けない（根拠: 甲）"),
      claimOf("R2", "要件の文 02。", "書けない（根拠: 乙）"),
      claimOf("R3", "要件の文 03。", "許される申告"),
      claimOf("R4", "要件の文 04。", "当たらない申告"),
    ];
    const scored = scoreClaims(claims, definition);
    expect(scored).toEqual({ correct: 2, missed: 0, allowed: 1, false_claims: [haystackOf(claims[3] as UnwritableRequirement)] });
    // 別の要件の文（text）だけでも当たる（keys は text にも当てる）
    const byText = scoreClaims([claimOf("R5", "根拠: 甲 を含む文。", "当たらない")], definition);
    expect(byText.correct).toBe(1);
  });

  it("PASS_NEEDS_CLAIM の本は missed 0 で PASS・1 以上で FAIL", () => {
    const complete = scoreClaims([claimOf("R1", "要件の文 01。", "書けない（根拠: 甲）"), claimOf("R2", "要件の文 02。", "書けない（根拠: 乙）")], definition);
    expect(complete.missed).toBe(0);
    expect(finalVerdict({ verdict: "PASS_NEEDS_CLAIM" }, complete)).toBe("PASS");
    const partial = scoreClaims([claimOf("R1", "要件の文 01。", "書けない（根拠: 甲）")], definition);
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
