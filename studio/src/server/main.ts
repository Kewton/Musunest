import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createToken } from "./guard.js";
import { resolveStudioHome } from "./home.js";
import { BIND_HOST, createStudioServer, DEFAULT_PORT, listen } from "./http.js";

// 工房の起動。環境ファイルはこのコードではなく、`pnpm start` の `node --env-file-if-exists` が読む。
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, "../client");

const parsePort = (value: string | undefined): number => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
};

export async function main(): Promise<void> {
  try {
    resolveStudioHome();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const token = createToken();
  const server = createStudioServer({
    staticDir,
    token,
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
