import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createToken } from "./guard.js";
import { resolveStudioHome } from "./home.js";
import { BIND_HOST, DEFAULT_PORT, createRequestHandler, listen } from "./http.js";
import { Jobs } from "./jobs.js";
import { handleApiRequest } from "./routes.js";
import { createFakeRunner } from "./runner-fake.js";

// 工房の起動。環境ファイルはこのコードではなく、`pnpm start` の `node --env-file-if-exists` が読む。
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "../client");

const parsePort = (value: string | undefined): number => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
};

export interface StudioAppOptions {
  readonly staticDir: string;
  readonly token: string;
  readonly pageValues?: Record<string, string>;
  /** 記録の置き場所（リポジトリの外） */
  readonly home: string;
  /** いまの時刻（試験は固定する） */
  readonly now?: () => number;
}

export interface StudioApp {
  readonly server: Server;
  readonly jobs: Jobs;
}

/**
 * `/api/jobs`・`/api/budget` の口を足した工房のサーバを作る（`node:http` だけ）。
 * 合言葉・Host・Origin の守りは `http.ts` の静的ファイルの扱いと、`routes.ts` の API の扱いの
 * 両方で同じものを使う。走らせる役は、この Issue では偽物だけ（工場は呼ばない）。
 */
export function createStudioAppServer(options: StudioAppOptions): StudioApp {
  const jobs = new Jobs({
    home: options.home,
    runner: createFakeRunner(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let staticHandler: ((request: IncomingMessage, response: ServerResponse) => void) | null = null;

  const server = createServer((request, response) => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : DEFAULT_PORT;
    if (staticHandler === null) {
      staticHandler = createRequestHandler({
        staticDir: options.staticDir,
        token: options.token,
        pageValues: options.pageValues ?? {},
        port,
      });
    }
    const fallback = staticHandler;
    void handleApiRequest(request, response, { jobs, token: options.token, port })
      .then((handled) => {
        if (!handled) fallback(request, response);
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end("Internal Server Error");
        } else {
          response.destroy();
        }
      });
  });

  return { server, jobs };
}

export async function main(): Promise<void> {
  let home: string;
  try {
    home = resolveStudioHome();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const token = createToken();
  const { server } = createStudioAppServer({
    staticDir,
    token,
    home,
    pageValues: {
      STUDIO_TOKEN: token,
      STUDIO_STAGING_ORIGIN: process.env.STUDIO_STAGING_ORIGIN ?? "",
    },
  });
  const port = await listen(server, parsePort(process.env.STUDIO_PORT));
  console.log(`studio: http://${BIND_HOST}:${port} を開いてください（localhost が ::1 に解決される環境がある）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
