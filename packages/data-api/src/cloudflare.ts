// Cloudflare の adapter。D1 / R2 / Durable Object の API を叩くのはこのファイルだけ。
//
// binding の型と、healthz の Probe の実体を置く。判定と応答の形は src/healthz.ts が持つ。
// アプリの経路（Issue #102）では、判定は src/app-api.ts が持ち、**ここは I/O の実体だけ**を渡す——
// D1 の登録（control-plane の RegistryExecutor）、R2 の正規化した JSON、DO のレコード。
import type { AppInstanceDO } from "@musunest/app-do";
import type { RecordData, RecordStamp, StoredRecord } from "@musunest/app-do";
import type { RegistryExecutor, SqlResult, SqlRow, SqlStatement } from "@musunest/control-plane";
import { resolveInstanceApp } from "@musunest/control-plane";
import type { Clock } from "@musunest/spec-engine";
import { systemClock } from "@musunest/spec-engine";
import type { DataApiDeps, InstanceRegistry, NormalizedSpecStore, RecordStore } from "./app-api";
import { ProbeFailure } from "./healthz";
import type { Probes } from "./healthz";

/** wrangler.jsonc の env.<env> が与える binding と vars。名前は src/contract.ts の定数と一致させる。 */
export interface DataApiEnv {
  /** Control Plane 専用の D1。アプリのデータは置かない（CLAUDE.md 不変条件） */
  readonly CONTROL_DB: D1Database;
  /** 生成 bundle の置き場 */
  readonly BUNDLES: R2Bucket;
  /** 利用者がアップロードしたファイルの置き場 */
  readonly UPLOADS: R2Bucket;
  /** 1アプリインスタンス＝1 DO（SQLite）。DO をバインドするのは data-api だけ（03 §4） */
  readonly APP_DO: DurableObjectNamespace<AppInstanceDO>;
  readonly ENVIRONMENT: string;
  readonly GIT_SHA: string;
}

/** R2 に書く probe のキー。bundle の名前空間と衝突しない接頭辞にしてある。 */
export const PROBE_OBJECT_KEY = "_probe/healthz";

/** healthz が叩く DO インスタンスの名前。アプリインスタンスの名前空間と衝突しない。 */
export const PROBE_DO_NAME = "_probe";

export function cloudflareProbes(env: DataApiEnv): Probes {
  return {
    async d1() {
      await env.CONTROL_DB.prepare("SELECT 1").first();
    },

    async r2() {
      // BUNDLES は書いて読み戻す（書き込み権限まで確かめる）。
      await env.BUNDLES.put(PROBE_OBJECT_KEY, new Date().toISOString());
      if ((await env.BUNDLES.head(PROBE_OBJECT_KEY)) === null) throw new ProbeFailure("BUNDLES head miss");
      // UPLOADS は利用者のデータ置き場なので書かない。head は無いキーなら null を返し、
      // バケットに届かなければ投げるので、binding の解決だけを確かめられる。
      await env.UPLOADS.head(PROBE_OBJECT_KEY);
    },

    async do() {
      const stub = env.APP_DO.get(env.APP_DO.idFromName(PROBE_DO_NAME));
      const result = await stub.healthz();
      if (!result.ok) throw new ProbeFailure("AppInstanceDO healthz not ok");
    },
  };
}

// ── アプリの経路（Issue #102）の I/O ──────────────────────────────
//
// ここが渡すのは**実体だけ**である。何を読むか・何を断るかは src/app-api.ts が決める。
// 例外の文言は応答に載せない（src/index.ts が 503 の固定本文にする）。詳細はログにだけ出す。

const toPrepared = (db: D1Database, statement: SqlStatement): D1PreparedStatement =>
  db.prepare(statement.sql).bind(...(statement.params ?? []));

/**
 * D1 を control-plane の RegistryExecutor に合わせて包む（型の対応は control-plane の
 * src/contract.ts にある）。control-plane に Cloudflare の型は出てこない。
 */
export function cloudflareRegistryExecutor(db: D1Database): RegistryExecutor {
  return {
    async query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]> {
      const result = await toPrepared(db, statement).all<Row>();
      return result.results ?? [];
    },
    async execute(statement: SqlStatement): Promise<number> {
      const result = await toPrepared(db, statement).run();
      return result.meta.changes ?? 0;
    },
    async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
      const results = await db.batch(statements.map((statement) => toPrepared(db, statement)));
      return results.map((result) => ({
        rows: (result.results ?? []) as readonly SqlRow[],
        changes: result.meta.changes ?? 0,
      }));
    },
  };
}

/** 登録（D1）を読む。**表の定義と SQL は control-plane が持つ**（data-api に SQL を書かない） */
export function cloudflareRegistry(env: DataApiEnv): InstanceRegistry {
  const executor = cloudflareRegistryExecutor(env.CONTROL_DB);
  return { resolve: (instanceId: string) => resolveInstanceApp(executor, instanceId) };
}

/** 正規化した JSON（R2）。無いキーは `null` で、例外にしない（呼ぶ側が 503 にする） */
export function cloudflareSpecStore(env: DataApiEnv): NormalizedSpecStore {
  return {
    async read(key: string): Promise<string | null> {
      const object = await env.BUNDLES.get(key);
      return object === null ? null : object.text();
    },
  };
}

/** アプリのレコード（1 インスタンス 1 DO）。判定は持たず、渡されたものをそのまま保存する */
export function cloudflareRecords(env: DataApiEnv, instanceId: string): RecordStore {
  const stub = env.APP_DO.get(env.APP_DO.idFromName(instanceId));
  return {
    create: (entity: string, data: RecordData, stamp: RecordStamp): Promise<StoredRecord> =>
      stub.createRecord(entity, data, stamp),
    list: (entity: string): Promise<StoredRecord[]> => stub.listRecords(entity),
  };
}

/**
 * 1 リクエスト分の依存を組む。レコードの置き場はインスタンスごとに別の DO なので、
 * env ではなくインスタンス ID で引く。
 *
 * 時計は既定で実時計（systemClock）。**HTTP から差し替える入口は作らない**（Q17）——
 * テストは app-api の関数に fixedClock を渡して採点する。
 */
export function cloudflareDataApi(
  env: DataApiEnv,
  instanceId: string,
  clock: Clock = systemClock(),
): DataApiDeps {
  return {
    registry: cloudflareRegistry(env),
    specs: cloudflareSpecStore(env),
    records: cloudflareRecords(env, instanceId),
    clock,
  };
}
