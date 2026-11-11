// 費用の台帳（JSON Lines。Issue #866 の目的・4）。
//
// 走りの開始で 1 回の上限（2.00 USD）を予約し、終わりで実額に置き換える。
// 「今日の実額＋未決の予約＋2.00 > 4.00」なら開始を断る（4.00 ちょうどは通る）。
// 日付は**手元の時刻**で切る。走っている間に落ちた分は、最後の概算で締めて `estimated` の印を付ける。
//
// 金額は**セント（整数）**で数える。小数の足し算で境目（4.00 ちょうど）を取り違えないため。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DAILY_LIMIT_USD, PER_RUN_LIMIT_USD } from "./runner.js";

interface ReserveLine {
  readonly kind: "reserve";
  readonly jobId: string;
  readonly at: number;
  readonly usd: number;
}

interface SettleLine {
  readonly kind: "settle";
  readonly jobId: string;
  readonly at: number;
  readonly usd: number;
  /** 概算で締めたか（落ちた走り・止めた走り） */
  readonly estimated: boolean;
}

type LedgerLine = ReserveLine | SettleLine;

/** 未決の予約 1 つ */
export interface OpenReservation {
  readonly jobId: string;
  readonly usd: number;
  readonly at: number;
}

/** 今日の費用の状態 */
export interface LedgerSummary {
  /** 今日に締まった実額 */
  readonly actualUsd: number;
  /** まだ締まっていない予約の合計 */
  readonly reservedUsd: number;
  /** 今日の実額＋未決の予約 */
  readonly spentUsd: number;
  /** 1 日の上限までの残り（負にはしない） */
  readonly remainingUsd: number;
  /** 新しい走りを始めてよいか */
  readonly canStart: boolean;
}

const perRunCents = Math.round(PER_RUN_LIMIT_USD * 100);
const dailyCents = Math.round(DAILY_LIMIT_USD * 100);

const toCents = (usd: number): number => Math.round(usd * 100);
const toUsd = (cents: number): number => cents / 100;

const isReserve = (value: unknown): value is ReserveLine => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === "reserve" && typeof record.jobId === "string" && typeof record.at === "number" && typeof record.usd === "number";
};

const isSettle = (value: unknown): value is SettleLine => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "settle" &&
    typeof record.jobId === "string" &&
    typeof record.at === "number" &&
    typeof record.usd === "number" &&
    typeof record.estimated === "boolean"
  );
};

/** 手元の時刻で、その日の始まりと次の日の始まりを返す */
function dayRange(now: number): { readonly start: number; readonly end: number } {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  return {
    start: new Date(year, month, day).getTime(),
    end: new Date(year, month, day + 1).getTime(),
  };
}

/**
 * 費用の台帳。`<baseDir>/ledger.jsonl` に 1 行ずつ追記する。
 * 読み直すたびにファイル全体を再生する（プロセスをまたいでも同じ答えになる）。
 */
export class Ledger {
  private readonly filePath: string;
  private readonly clock: () => number;

  constructor(filePath: string, clock: () => number = () => Date.now()) {
    this.filePath = filePath;
    this.clock = clock;
  }

  /** 走りの開始で予約する */
  reserve(jobId: string, usd: number = PER_RUN_LIMIT_USD): void {
    this.append({ kind: "reserve", jobId, at: this.clock(), usd });
  }

  /** 走りの終わりで実額（または概算）に置き換える */
  settle(jobId: string, usd: number, estimated: boolean): void {
    this.append({ kind: "settle", jobId, at: this.clock(), usd, estimated });
  }

  /** まだ締まっていない予約 */
  openReservations(): readonly OpenReservation[] {
    const open = new Map<string, OpenReservation>();
    for (const line of this.read()) {
      if (line.kind === "reserve") {
        open.set(line.jobId, { jobId: line.jobId, usd: line.usd, at: line.at });
      } else {
        open.delete(line.jobId);
      }
    }
    return [...open.values()];
  }

  /** 今日の費用の状態 */
  summary(now: number = this.clock()): LedgerSummary {
    const { start, end } = dayRange(now);
    const lines = this.read();

    const open = new Map<string, number>();
    let actualCents = 0;
    for (const line of lines) {
      if (line.kind === "reserve") {
        open.set(line.jobId, toCents(line.usd));
        continue;
      }
      open.delete(line.jobId);
      if (line.at >= start && line.at < end) actualCents += toCents(line.usd);
    }

    const reservedCents = [...open.values()].reduce((total, cents) => total + cents, 0);
    const spentCents = actualCents + reservedCents;
    return {
      actualUsd: toUsd(actualCents),
      reservedUsd: toUsd(reservedCents),
      spentUsd: toUsd(spentCents),
      remainingUsd: toUsd(Math.max(0, dailyCents - spentCents)),
      // 4.00 ちょうどは通る（`>` の取り違えを捕まえる試験がある）
      canStart: spentCents + perRunCents <= dailyCents,
    };
  }

  /** 新しい走りを始めてよいか */
  canStart(now: number = this.clock()): boolean {
    return this.summary(now).canStart;
  }

  private append(line: LedgerLine): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, "utf8");
  }

  private read(): readonly LedgerLine[] {
    if (!existsSync(this.filePath)) return [];
    const lines: LedgerLine[] = [];
    for (const raw of readFileSync(this.filePath, "utf8").split("\n")) {
      const text = raw.trim();
      if (text === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`台帳の行が JSON ではない: ${text}`);
      }
      if (isReserve(parsed) || isSettle(parsed)) {
        lines.push(parsed);
        continue;
      }
      throw new Error(`台帳の行の形が知らない: ${text}`);
    }
    return lines;
  }
}

/** 既定の台帳のファイル名 */
export const LEDGER_FILE = "ledger.jsonl";
