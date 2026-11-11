import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "./ledger.js";

let directory: string;
let now: number;
let ledger: Ledger;

const ledgerPath = (): string => join(directory, "ledger.jsonl");

const today = (): number => new Date(2026, 10, 11, 12, 0, 0).getTime();
const yesterday = (): number => new Date(2026, 10, 10, 12, 0, 0).getTime();

const settleToday = (jobId: string, usd: number): void => {
  ledger.reserve(jobId);
  ledger.settle(jobId, usd, false);
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "musunest-ledger-"));
  now = today();
  ledger = new Ledger(ledgerPath(), () => now);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("Ledger の上限", () => {
  it("今日の実額 2.10 に予約 0 なら、開始を断る（2.10＋2.00 > 4.00）", () => {
    settleToday("seed", 2.1);
    const summary = ledger.summary();
    expect(summary.actualUsd).toBeCloseTo(2.1, 2);
    expect(summary.reservedUsd).toBe(0);
    expect(summary.spentUsd).toBeCloseTo(2.1, 2);
    expect(ledger.canStart()).toBe(false);
  });

  it("今日の実額 1.99 なら通る", () => {
    settleToday("seed", 1.99);
    expect(ledger.canStart()).toBe(true);
    expect(ledger.summary().remainingUsd).toBeCloseTo(2.01, 2);
  });

  it("境目の 2.00 ちょうどは通る（4.00 を超えていない）", () => {
    settleToday("seed", 2);
    expect(ledger.summary().spentUsd).toBe(2);
    expect(ledger.canStart()).toBe(true);
  });

  it("境目を 1 セントでも超えたら断る（`>=` の取り違えを捕まえる）", () => {
    settleToday("seed", 2.01);
    expect(ledger.canStart()).toBe(false);
  });

  it("前日の額は数えない", () => {
    now = yesterday();
    settleToday("old", 2.1);
    now = today();
    expect(ledger.summary().actualUsd).toBe(0);
    expect(ledger.summary().spentUsd).toBe(0);
    expect(ledger.canStart()).toBe(true);
  });
});

describe("Ledger の予約と締め", () => {
  it("予約は未決として数え、締めると実額に置き換わる", () => {
    ledger.reserve("running");
    expect(ledger.summary().reservedUsd).toBe(2);
    expect(ledger.summary().actualUsd).toBe(0);
    expect(ledger.openReservations()).toEqual([{ jobId: "running", usd: 2, at: now }]);

    now += 1_000;
    ledger.settle("running", 0.42, false);
    expect(ledger.summary().reservedUsd).toBe(0);
    expect(ledger.summary().actualUsd).toBeCloseTo(0.42, 2);
    expect(ledger.openReservations()).toEqual([]);
  });

  it("落ちた走りの予約は概算で締まり、`estimated` の印が付く", () => {
    ledger.reserve("crashed");
    now += 5_000;
    ledger.settle("crashed", 0.3, true);

    const lines = readFileSync(ledgerPath(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toEqual({ kind: "settle", jobId: "crashed", at: now, usd: 0.3, estimated: true });
    expect(ledger.summary().actualUsd).toBeCloseTo(0.3, 2);
    expect(ledger.openReservations()).toEqual([]);
  });

  it("台帳は追記の JSON Lines である", () => {
    ledger.reserve("a");
    ledger.settle("a", 0.1, false);
    const raw = readFileSync(ledgerPath(), "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0] ?? "")).toMatchObject({ kind: "reserve", jobId: "a" });
    expect(JSON.parse(raw[1] ?? "")).toMatchObject({ kind: "settle", jobId: "a", estimated: false });
  });
});
