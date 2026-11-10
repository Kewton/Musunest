// 計画で了承して除いた部分の導出・C2 の要求・C2' の受理・判定の材料（Issue #841）。
// 偽物の LLM と固定の材料だけを使い、外部の API は呼ばない。受入の題材の言葉は使わない。
import { describe, expect, it } from "vitest";
import type { ConfirmedPlan, PlanPart } from "@musunest/appspec-schema";
import { createFakeLlmClient } from "../llm-fake.js";
import { expectNoAcceptanceMaterial, makeGateway } from "../stages/__tests__/prompt.js";
import { FIXTURE_CONSTRAINT_ID, FIXTURE_DOCUMENTS, fixtureList, fixtureTable, planOf, withCodeIds } from "../v11a/__tests__/fixtures.js";
import { checkMappedTable, PART_BASIS_MESSAGE, type NameTable } from "../v11a/names.js";
import { acceptedCarryOverIds, deriveAcceptedParts } from "./accepted-parts.js";
import { PROPERTY_LEDGER_VIEW } from "./ledger.js";
import { mappingRuleDefinitionsOf, mappingWholeRequestOf, MAPPING_ACCEPTED_DATA_NAMES } from "./stages/mapping.js";

const part = (id: string, disposition: PlanPart["disposition"], text = `部分 ${id}`): PlanPart => ({ id, text, disposition });

/** 題材の計画に、要件ごとの部分と了承して除いた部分を差し込んだもの */
function planWith(
  parts: Readonly<Record<string, readonly PlanPart[]>>,
  accepted: readonly string[] = [],
): ConfirmedPlan {
  const base = planOf(fixtureList());
  return {
    ...base,
    requirements: base.requirements.map((requirement) => ({ ...requirement, parts: parts[requirement.id] ?? [] })),
    accepted_unwritable: accepted.map((part_id) => ({
      part_id,
      alternative_id: "R5",
      basis: { doc_version: "v1", location: "1", constraint_id: FIXTURE_CONSTRAINT_ID },
    })),
  };
}

/** 確かめ方を unresolved（根拠は渡した ID）に差し替えた表 */
function unresolvedTable(requirementId: string, constraintIds: readonly string[]): NameTable {
  const table = withCodeIds(fixtureTable());
  return {
    ...table,
    verification: table.verification.map((entry) =>
      entry.requirementId === requirementId
        ? { requirementId, kind: "unresolved", reason: "宣言で書けない", constraintIds }
        : entry,
    ),
  };
}

describe("(1) 了承して除いた部分の導出", () => {
  const plan = planWith(
    {
      R1: [part("R1-a", "accepted_removal"), part("R1-b", "accepted_removal")],
      R2: [part("R2-a", "met"), part("R2-b", "accepted_removal")],
      R3: [part("R3-a", "accepted_removal")],
      R4: [part("R4-a", "alternative")],
      R5: [],
    },
    ["R1-a", "R1-b", "R2-b", "R4-a"],
  );

  it("全部が了承済みの要件は 1 件目だけ。accepted_unwritable に無い部分・alternative・空の parts は入らない", () => {
    const derived = deriveAcceptedParts(plan);
    expect(derived.allAcceptedRequirementIds).toEqual(["R1"]);
    // 了承済みの部分を持つ要件は、混在・了承されていない部分を持つものを除いて計画の順
    expect(derived.requirements.map((entry) => entry.requirementId)).toEqual(["R1", "R2"]);
    expect(derived.requirements.map((entry) => entry.allAccepted)).toEqual([true, false]);
    expect(derived.requirements.find((entry) => entry.requirementId === "R2")?.acceptedPartIds).toEqual(["R2-b"]);
    // R3 は accepted_removal だが accepted_unwritable に無い→了承済みでない。R4 は alternative。R5 は空の parts
    expect(derived.basis.byRequirement.get("R3")?.acceptedPartIds.size).toBe(0);
    expect(derived.basis.byRequirement.get("R4")?.acceptedPartIds.size).toBe(0);
    expect(derived.basis.byRequirement.get("R5")?.allAccepted).toBe(false);
  });

  it("(1) 所属と了承は元の ID で照らし、正規化で衝突する ID は根拠用の索引から除く（Issue #844）", () => {
    const collision = planWith(
      {
        R1: [part("p", "accepted_removal")],
        R2: [part(" p ", "accepted_removal")],
        R3: [part("R3-a", "met")],
      },
      ["p"],
    );
    const derived = deriveAcceptedParts(collision);
    // 了承ありの `p` だけが全部が了承済み。了承の参照に無い ` p ` は了承済みにならない
    expect(derived.allAcceptedRequirementIds).toEqual(["R1"]);
    expect(derived.basis.byRequirement.get("R2")?.allAccepted).toBe(false);
    expect(derived.basis.byRequirement.get("R2")?.acceptedPartIds.size).toBe(0);
    // 正規化で衝突する `p` はどちらの部分も索引に入らない（C2' の受理・判定の材料）
    expect(derived.basis.anyPartIds.has("p")).toBe(false);
    expect(derived.basis.byRequirement.get("R1")?.acceptedPartIds.has("p")).toBe(false);
    expect(derived.basis.byRequirement.get("R1")?.partIds.has("p")).toBe(false);
    // C2 に渡す塊にも、了承していない R2 は入らない
    expect(derived.requirements.map((entry) => entry.requirementId)).toEqual(["R1"]);
  });

  it("0 件なら何も足さない（空の requirements・空の索引）", () => {
    const derived = deriveAcceptedParts(planWith({ R1: [part("R1-a", "met")] }));
    expect(derived.requirements).toEqual([]);
    expect(derived.allAcceptedRequirementIds).toEqual([]);
    expect(derived.basis.byRequirement.get("R1")?.acceptedPartIds.size).toBe(0);
  });
});

describe("(2) C2 の要求：根拠の集合と範囲の外の文", () => {
  const r3 = (accepted: boolean, ledger: boolean) =>
    mappingRuleDefinitionsOf(ledger ? PROPERTY_LEDGER_VIEW : undefined, accepted).find((definition) => definition.id === "R-map-03")?.text ?? "";

  it("台帳なし・ありのどちらでも、許す集合を広げ、範囲の外の文を条件で分ける（旧の文も一律の文も残らない）", () => {
    for (const text of [r3(true, false), r3(true, true)]) {
      expect(text).toContain("計画で了承して除いた部分の ID に限る");
      expect(text).toContain("了承済みの部分と了承していない部分を両方持つ要件");
      expect(text).toContain("残りの部分を通常の確かめ方");
      expect(text).toContain("部分が全部了承済みで書ける残りが無い要件だけ");
      // 旧の「一覧にだけ」の文と、一律に unresolved にしない文は残らない
      expect(text).not.toContain("根拠となる制約 ID を一覧から挙げられない要件は unresolved にしない");
      expect(text).not.toContain("根拠を一覧から挙げられない要件は unresolved にしない");
      expect(text).not.toContain("文書の制約 ID の一覧にあるものだけ）書く");
    }
  });

  it("了承済みが 0 件の計画の R-map-03 は今の文とバイト列で同じ", () => {
    const base = mappingRuleDefinitionsOf(undefined).find((definition) => definition.id === "R-map-03")?.text;
    const same = mappingRuleDefinitionsOf(undefined, false).find((definition) => definition.id === "R-map-03")?.text;
    expect(same).toBe(base);
    expect(base).toContain("根拠となる制約 ID を一覧から挙げられない要件は unresolved にしない");
  });

  it("データの塊は了承済みの部分を持つ計画だけに足し、要件 ID・部分 ID・部分の文・全部が了承済みかを渡す", () => {
    const list = fixtureList();
    const acceptedParts = deriveAcceptedParts(planWith({ R5: [part("R5-a", "accepted_removal")] }, ["R5-a"]));
    const gateway = makeGateway(createFakeLlmClient([]));
    const request = mappingWholeRequestOf({
      plan: planOf(list),
      list,
      documents: FIXTURE_DOCUMENTS,
      gateway,
      rows: withCodeIds(fixtureTable()).rows,
      acceptedParts,
    });
    const block = request.input.split(`<data name="${MAPPING_ACCEPTED_DATA_NAMES.accepted}">\n`)[1]?.split("\n</data>")[0];
    expect(block).toBeDefined();
    expect(JSON.parse(block ?? "null")).toEqual({
      requirements: [{ requirementId: "R5", allAccepted: true, parts: [{ id: "R5-a", text: "部分 R5-a" }] }],
    });

    const plain = mappingWholeRequestOf({ plan: planOf(list), list, documents: FIXTURE_DOCUMENTS, gateway, rows: withCodeIds(fixtureTable()).rows });
    expect(plain.input).not.toContain(MAPPING_ACCEPTED_DATA_NAMES.accepted);
  });
});

describe("(3) C2' の部分 ID の受理", () => {
  it("全部が了承済みの要件の部分 ID は受理する（索引を渡さない base は断る＝赤）", () => {
    const plan = planWith({ R1: [part("R1-p1", "accepted_removal")] }, ["R1-p1"]);
    const list = fixtureList();
    const table = unresolvedTable("R1", ["R1-p1"]);
    const derived = deriveAcceptedParts(plan);
    expect(checkMappedTable(list, table, FIXTURE_DOCUMENTS, { acceptedParts: derived.basis })).toEqual([]);
    expect(checkMappedTable(list, table, FIXTURE_DOCUMENTS).map((problem) => problem.message)).toEqual(["制約 ID が文書に無い"]);
  });

  it("混在・別の要件・met・alternative・accepted_unwritable に無い部分は固定文で断る", () => {
    const plan = planWith(
      {
        R1: [part("R1-p1", "accepted_removal")],
        R2: [part("R2-met", "met"), part("R2-p1", "accepted_removal")],
        R3: [part("R3-alt", "alternative")],
        R4: [part("R4-p1", "accepted_removal")],
      },
      ["R1-p1", "R2-p1", "R3-alt"],
    );
    const list = fixtureList();
    const derived = deriveAcceptedParts(plan);
    const messages = (requirementId: string, ids: readonly string[]) =>
      checkMappedTable(list, unresolvedTable(requirementId, ids), FIXTURE_DOCUMENTS, { acceptedParts: derived.basis }).map(
        (problem) => problem.message,
      );
    // 混在の要件の了承済みの部分 ID
    expect(messages("R2", ["R2-p1"])).toEqual([PART_BASIS_MESSAGE]);
    // 別の要件の部分 ID
    expect(messages("R2", ["R1-p1"])).toEqual([PART_BASIS_MESSAGE]);
    // met・alternative・accepted_unwritable に無い部分
    expect(messages("R2", ["R2-met"])).toEqual([PART_BASIS_MESSAGE]);
    expect(messages("R3", ["R3-alt"])).toEqual([PART_BASIS_MESSAGE]);
    expect(messages("R4", ["R4-p1"])).toEqual([PART_BASIS_MESSAGE]);
  });

  it("文書の ID と同じ文字列の部分 ID は、文書の ID として受ける", () => {
    const plan = planWith({ R2: [part(FIXTURE_CONSTRAINT_ID, "accepted_removal"), part("R2-x", "met")] }, []);
    const list = fixtureList();
    const table = unresolvedTable("R2", [FIXTURE_CONSTRAINT_ID]);
    expect(checkMappedTable(list, table, FIXTURE_DOCUMENTS, { acceptedParts: deriveAcceptedParts(plan).basis })).toEqual([]);
  });
});

describe("(5) 判定の材料：了承済みの持ち越しの導出", () => {
  const basis = deriveAcceptedParts(
    planWith(
      {
        R1: [part("R1-p1", "accepted_removal")],
        R2: [part("R2-p1", "accepted_removal"), part("R2-p2", "met")],
      },
      ["R1-p1", "R2-p1"],
    ),
  ).basis;
  const entry = (requirementId: string, origins: readonly string[] = ["name-table"]) => ({
    requirementId,
    reasons: origins.map((origin) => ({ origin, reason: "宣言で書けない" })),
  });
  const derive = (input: {
    entries: readonly ReturnType<typeof entry>[];
    unresolved: ReadonlyMap<string, readonly string[]>;
    documents?: readonly string[];
    observations?: readonly string[];
  }) =>
    acceptedCarryOverIds({
      entries: input.entries,
      unresolvedConstraintIds: input.unresolved,
      basis,
      documentConstraintIds: new Set(input.documents ?? []),
      observationIds: new Set(input.observations ?? []),
    });

  it("全部が了承済みの要件の、了承済みの部分 ID だけを根拠にした name-table の持ち越しだけを除く", () => {
    expect(derive({ entries: [entry("R1")], unresolved: new Map([["R1", ["R1-p1"]]]) })).toEqual(["R1"]);
  });

  it("混在の要件の部分 ID・文書と部分の混在・文書の ID だけ・文字列の衝突・正規化して 0 件・name-table とほかの出どころは除かない", () => {
    // 混在の要件
    expect(derive({ entries: [entry("R2")], unresolved: new Map([["R2", ["R2-p1"]]]) })).toEqual([]);
    // 文書の ID と部分 ID の混在
    expect(
      derive({ entries: [entry("R1")], unresolved: new Map([["R1", ["R1-p1", FIXTURE_CONSTRAINT_ID]]]), documents: [FIXTURE_CONSTRAINT_ID] }),
    ).toEqual([]);
    // 文書の ID だけ（全部が了承済みの要件でも）
    expect(derive({ entries: [entry("R1")], unresolved: new Map([["R1", [FIXTURE_CONSTRAINT_ID]]]), documents: [FIXTURE_CONSTRAINT_ID] })).toEqual([]);
    // 文字列の衝突（部分 ID と同じ文字列が文書の ID にある）
    expect(derive({ entries: [entry("R1")], unresolved: new Map([["R1", ["R1-p1"]]]), documents: ["R1-p1"] })).toEqual([]);
    // 正規化して 0 件
    expect(derive({ entries: [entry("R1")], unresolved: new Map([["R1", ["  "]]]) })).toEqual([]);
    // name-table とほかの出どころの混在
    expect(derive({ entries: [entry("R1", ["name-table", "semantic-check"])], unresolved: new Map([["R1", ["R1-p1"]]]) })).toEqual([]);
  });

  it("了承済みの持ち越しと別の未解決が並ぶときは、了承済みだけを除く（partial のまま）", () => {
    expect(
      derive({
        entries: [entry("R1"), entry("R2"), entry("R3")],
        unresolved: new Map([
          ["R1", ["R1-p1"]],
          ["R2", ["R2-p1"]],
          ["R3", [FIXTURE_CONSTRAINT_ID]],
        ]),
        documents: [FIXTURE_CONSTRAINT_ID],
      }),
    ).toEqual(["R1"]);
  });
});

interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

describe("題材の言葉の走査（Issue #841）", () => {
  it("新規の accepted-parts.ts・accepted-parts.test.ts と C2 の mapping.ts に受入の題材の言葉が無い", () => {
    const files = ["./accepted-parts.ts", "./accepted-parts.test.ts", "./stages/mapping.ts"];
    expectNoAcceptanceMaterial(files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")));
  });
});
