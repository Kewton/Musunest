// local-dev / テスト専用のハーネス Worker。
//
// **これは配備しない。** 本番経路で DO に触れてよいのは data-api だけである
// （CLAUDE.md 不変条件「Data API が唯一の権限強制点」／03-workers-and-bindings.md §4
// 「DO は data-api にだけバインドする」）。ルートも workers_dev も持たず、
// `pnpm deploy:*` の --filter にも入っていない。
//
// 存在理由は1つ：`wrangler.jsonc` の new_sqlite_classes migration を実際に適用した
// workerd の上で AppInstanceDO を起動し、SQLite の読み書きと WebSocket 接続を
// HTTP から叩けるようにすること。src/index.test.ts がこの入口を使う。
import { AppInstanceDO } from "./index";
import type { AppDoEnv } from "./index";
import type { RecordData, RecordStamp } from "./contract";

export { AppInstanceDO };

const DEFAULT_INSTANCE = "m0";

/** 宣言の entity のレコードの入口（Issue #99）。 */
const RECORDS_PREFIX = "/records/";

function stubFor(env: AppDoEnv, url: URL): DurableObjectStub<AppInstanceDO> {
  const name = url.searchParams.get("app") ?? DEFAULT_INSTANCE;
  return env.APP_DO.get(env.APP_DO.idFromName(name));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * テストが時計と ID 生成器を固定するための query（`?now=…&id=…`）。
 *
 * **これはテスト用の入口である。** 公開 API ではない——公開の経路で時計を差し替える口を
 * 作らないという決定（`workspace/mvp/m1/00-open-questions.md` Q17）は data-api の話であって、
 * ここは workerd の上で本物の SQLite を確かめるためのハーネスである（この file の冒頭を参照）。
 */
function recordStamp(url: URL): RecordStamp {
  const now = url.searchParams.get("now");
  const id = url.searchParams.get("id");
  return {
    ...(now === null ? {} : { now }),
    ...(id === null ? {} : { id }),
  };
}

async function recordData(request: Request): Promise<RecordData> {
  return (await request.json()) as RecordData;
}

/** `/records/<entity>` と `/records/<entity>/<id>` を、DO の RPC へそのまま橋渡しする。 */
async function records(
  request: Request,
  url: URL,
  stub: DurableObjectStub<AppInstanceDO>,
): Promise<Response> {
  const [entity, id, ...rest] = url.pathname.slice(RECORDS_PREFIX.length).split("/");
  if (entity === undefined || entity === "" || rest.length > 0) {
    return json({ error: "not found", pathname: url.pathname }, 404);
  }
  const entityName = decodeURIComponent(entity);
  const stamp = recordStamp(url);

  if (id === undefined) {
    switch (request.method) {
      case "GET":
        return json(await stub.listRecords(entityName));
      case "POST":
        return json(await stub.createRecord(entityName, await recordData(request), stamp));
      default:
        return json({ error: "method not allowed" }, 405);
    }
  }

  const recordId = decodeURIComponent(id);
  switch (request.method) {
    case "GET":
      return json(await stub.getRecord(entityName, recordId));
    case "PUT":
      return json(
        await stub.updateRecord(entityName, recordId, await recordData(request), stamp),
      );
    case "DELETE":
      return json(await stub.deleteRecord(entityName, recordId));
    default:
      return json({ error: "method not allowed" }, 405);
  }
}

export default {
  async fetch(request: Request, env: AppDoEnv): Promise<Response> {
    const url = new URL(request.url);
    const stub = stubFor(env, url);

    if (url.pathname === "/ws") {
      // WebSocket のアップグレードは DO 自身が受ける（Hibernation API を使うため）。
      return stub.fetch(request);
    }

    if (url.pathname === "/healthz") {
      return json(await stub.healthz());
    }

    if (url.pathname === "/kv") {
      return json(await stub.list());
    }

    if (url.pathname.startsWith(RECORDS_PREFIX)) {
      return records(request, url, stub);
    }

    if (url.pathname.startsWith("/kv/")) {
      const key = decodeURIComponent(url.pathname.slice("/kv/".length));
      switch (request.method) {
        case "GET": {
          const entry = await stub.get(key);
          return entry ? json(entry) : json({ error: "not found", key }, 404);
        }
        case "PUT":
          return json(await stub.put(key, await request.text()));
        case "DELETE":
          return json({ key, deleted: await stub.delete(key) });
        default:
          return json({ error: "method not allowed" }, 405);
      }
    }

    if (url.pathname === "/storage-size") {
      return json({ bytes: await stub.storageSize() });
    }

    return json({ error: "not found", pathname: url.pathname }, 404);
  },
} satisfies ExportedHandler<AppDoEnv>;
