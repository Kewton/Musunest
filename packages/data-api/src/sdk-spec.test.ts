// SDK（`isSpecBody`・`isViewBody`）が、samples/ の見本の**正規化 JSON をすべて**受け取れること（Issue #145）。
//
// 何を守るか：SDK の検証は**手で書いた応答の形**しか見ていなかったので、宣言に `settle`（精算）を
// 足しても気づかず、staging の `warikan` が画面で `通信に失敗しました` になった。**見本そのものを通す**
// ことで、宣言の語彙が増えたときに検証側の取り残しをテストが検出する。
//
// なぜ data-api か：正規化には @musunest/spec-engine が要るが、@musunest/sdk は
// @musunest/appspec-schema しか解決できない（pnpm の isolated linker と依存の向き。CLAUDE.md）。
// 3 つとも持つのは data-api だけである。**依存の向きは変えない。**
//
// 見本は samples/ のディレクトリを**その場で読む**ので、見本が 1 つ増えれば自動で対象になる
// （名前を手で並べない。並べると、増えた見本が検証の外に残る）。
//
// 応答は data-api の `getSpec`・`getView`（正規の入口）に作らせ、それを **SDK のクライアント**へ通す。
// つまり「店頭が返す形」と「SDK が受ける形」の両方を、同じ 1 本で突き合わせる。

import { describe, expect, it } from "vitest";
import type { ApiSpecBody, NormalizedAppSpec } from "@musunest/appspec-schema";
import { NEGATIVES_DIR_NAME, sampleSpecFile, samplesDir } from "@musunest/appspec-schema/files";
import type { AppRecord } from "@musunest/control-plane";
import { INVALID_RESPONSE, createMusunestClient } from "@musunest/sdk";
import type { FetchLike } from "@musunest/sdk";
import { fixedClock, normalizeSpec } from "@musunest/spec-engine";
import type { DataApiDeps, RecordStore } from "./app-api.js";
import { getSpec, getView } from "./app-api.js";

// tsconfig の types は workers-types だけなので、Node の API の形だけをここで宣言する
// （このファイルは Node（vitest）で動く。data-api のほかのテストと同じやり方）。
interface DirEntry {
  readonly name: string;
  isDirectory(): boolean;
}
interface NodeFileSystem {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL, options: { withFileTypes: true }): DirEntry[];
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFileSystem;

// ── 見本の列挙（ディレクトリを読む。名前を手で並べない） ──────────────

/** samples/ の下の見本（負例のディレクトリと隠しファイルは数えない） */
const sampleNames = fs
  .readdirSync(samplesDir(), { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && entry.name !== NEGATIVES_DIR_NAME && !entry.name.startsWith("."),
  )
  .map((entry) => entry.name);

interface Sample {
  readonly app: NormalizedAppSpec;
  /** publish が R2 に置く本文（`getSpec` に渡すのと同じ形） */
  readonly json: string;
}

const samples = new Map<string, Sample>();
for (const name of sampleNames) {
  const normalized = await normalizeSpec(fs.readFileSync(sampleSpecFile(name), "utf8"));
  if (!normalized.ok) throw new Error(`見本 ${name} が静的チェックに通らない`);
  samples.set(name, { app: normalized.app, json: normalized.json });
}

const sampleOf = (name: string): Sample => {
  const sample = samples.get(name);
  if (sample === undefined) throw new Error(`見本 ${name} を読めていない`);
  return sample;
};

// ── data-api の応答（正規の入口で組む） ──────────────────────────

const INSTANCE = "inst-sdk-spec";

/** 空の DO。**spec はレコードを読まない**が、一覧は読むので空の並びを返す */
const emptyRecords: RecordStore = {
  create: async () => {
    throw new Error("この検査では使わない");
  },
  list: async () => [],
  get: async () => null,
  update: async () => {
    throw new Error("この検査では使わない");
  },
  deleteGuarded: async () => {
    throw new Error("この検査では使わない");
  },
};

function depsFor(sample: Sample): DataApiDeps {
  const registration: AppRecord = {
    sourceSha256: sample.app.sourceSha256,
    schemaVersion: sample.app.schemaVersion,
    sourceKey: `specs/${sample.app.sourceSha256}/app.spec.yaml`,
    normalizedKey: `specs/${sample.app.sourceSha256}/normalized.json`,
    createdAt: "2026-09-17T00:00:00.000Z",
  };
  return {
    registry: { resolve: async () => registration },
    specs: { read: async () => sample.json },
    records: emptyRecords,
    clock: fixedClock("2026-09-17T12:00:00+09:00"),
  };
}

/** 店頭の spec 応答（正規化した見本そのもの） */
async function servedSpec(sample: Sample): Promise<ApiSpecBody> {
  const result = await getSpec(depsFor(sample), INSTANCE);
  if (!result.ok) throw new Error(`data-api が spec を返さない: ${result.failure.error}`);
  return result.body;
}

// ── SDK のクライアント（応答を 1 つだけ返す fetch を通す） ─────────────

/** JSON の応答を返す fetch（`decode` の経路をそのまま通す） */
const reply = (body: unknown): FetchLike => () =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);

const clientFor = (body: unknown) => createMusunestClient({ baseUrl: "", fetch: reply(body) });

// ── 見本をすべて通す（M1.1 と M1.2 の両方。見本が増えれば自動で入る） ──────

describe("samples/ の見本を、SDK の検証がすべて受け取る", () => {
  it("見本のディレクトリには expense-log と warikan がある（増えれば自動で対象になる）", () => {
    expect(sampleNames).toEqual(expect.arrayContaining(["expense-log", "warikan"]));
    expect(sampleNames.length).toBeGreaterThanOrEqual(2);
  });

  it.each(sampleNames)("見本 %s の spec を、SDK の getSpec が ok で返す", async (name) => {
    const served = await servedSpec(sampleOf(name));
    const result = await clientFor(served).getSpec(INSTANCE);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(served);
  });

  it.each(sampleNames)("見本 %s のすべての一覧を、SDK の getView が ok で返す", async (name) => {
    const sample = sampleOf(name);
    const deps = depsFor(sample);
    for (const view of sample.app.spec.views) {
      const served = await getView(deps, INSTANCE, view.name);
      if (!served.ok) throw new Error(`data-api が一覧 ${view.name} を返さない: ${served.failure.error}`);

      const result = await clientFor(served.body).getView(INSTANCE, view.name);
      expect(result.ok, view.name).toBe(true);
      if (result.ok) expect(result.value, view.name).toEqual(served.body);
    }
  });
});

// ── 精算（settle）の宣言の形（Issue #145 の受入条件） ────────────────
//
// `expression`・`aggregate`・`settle` は**どれか 1 つだけ**である（同時には書けない）。
// `settle` の欄（`expense` / `amount` / `payer` / `shares`）は**いずれも文字列**である。
// 併記・非文字列は SDK が不正として弾く（成功の型へキャストしない）。

/** `settle` の計算 1 件を、ほかの欄は見本のまま差し替えた spec 応答 */
const withSettlement = (body: ApiSpecBody, entry: Record<string, unknown>): unknown => ({
  ...body,
  spec: {
    ...body.spec,
    computed: body.spec.computed.map((computed) =>
      computed.name === "settlement" && "settle" in computed ? entry : computed,
    ),
  },
});

const settleEntryOf = (body: ApiSpecBody): Record<string, unknown> => {
  const entry = body.spec.computed.find((computed) => "settle" in computed);
  if (entry === undefined) throw new Error("warikan に settle の宣言が無い");
  return entry as unknown as Record<string, unknown>;
};

type Mutation = (entry: Record<string, unknown>) => Record<string, unknown>;

const SETTLE_NEGATIVES: [string, Mutation][] = [
  ["expression を併記した settle", (entry) => ({ ...entry, expression: "paid - owed" })],
  [
    "aggregate を併記した settle",
    (entry) => ({ ...entry, aggregate: { kind: "count", entity: "expense", name: null, where: {} } }),
  ],
  [
    "settle の額が文字列でない",
    (entry) => ({
      ...entry,
      settle: { ...(entry["settle"] as Record<string, unknown>), amount: 1 },
    }),
  ],
  [
    "settle の欄が欠けている",
    (entry) => ({ ...entry, settle: { expense: "expense", amount: "amount", payer: "payer" } }),
  ],
  ["settle がオブジェクトでない", (entry) => ({ ...entry, settle: "settlement" })],
];

describe("精算（settle）の宣言の形", () => {
  it("見本 warikan の settle は、そのまま受け取る（正例）", async () => {
    const served = await servedSpec(sampleOf("warikan"));
    expect((await clientFor(served).getSpec(INSTANCE)).ok).toBe(true);
  });

  it.each(SETTLE_NEGATIVES)("%s は INVALID_RESPONSE", async (_label, mutate) => {
    const served = await servedSpec(sampleOf("warikan"));
    const broken = withSettlement(served, mutate(settleEntryOf(served)));

    expect(await clientFor(broken).getSpec(INSTANCE)).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });

  it("式の計算は `type: number` を要する（M1.1 の判定を変えない）", async () => {
    const served = await servedSpec(sampleOf("expense-log"));
    const computed = served.spec.computed as unknown as readonly Record<string, unknown>[];
    const withoutType = computed.map((entry) => {
      const rest = { ...entry };
      delete rest["type"];
      return rest;
    });
    const broken = { ...served, spec: { ...served.spec, computed: withoutType } };

    expect(await clientFor(broken).getSpec(INSTANCE)).toMatchObject({
      ok: false,
      error: { status: 200, code: INVALID_RESPONSE },
    });
  });
});
