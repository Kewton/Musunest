import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { guardRequest, pathname } from "./guard.js";
import { renderPage } from "./page.js";

// 工房のサーバの殻。`node:http` だけで、127.0.0.1 にだけ bind する（0.0.0.0 は使わない）。
// 束ねた画面（dist/client）を返し、`/api/` の下は JSON。最初の口は `GET /api/health` だけ。
export const BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4318;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface StudioServerOptions {
  staticDir: string;
  token: string;
  pageValues?: Record<string, string>;
  port?: number;
}

interface HandlerOptions {
  staticDir: string;
  token: string;
  pageValues: Record<string, string>;
  port: number;
}

const sendText = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};

const serveStatic = (request: IncomingMessage, response: ServerResponse, options: HandlerOptions, rawPath: string): void => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    sendText(response, 400, "Bad Request");
    return;
  }

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = resolve(options.staticDir, relative);
  if (filePath !== options.staticDir && !filePath.startsWith(`${options.staticDir}${sep}`)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(response, 404, "Not Found");
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
  const method = request.method ?? "GET";

  if (extension === ".html") {
    const body = renderPage(readFileSync(filePath, "utf8"), options.pageValues);
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(method === "HEAD" ? undefined : body);
    return;
  }

  response.writeHead(200, { "content-type": contentType });
  if (method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) sendText(response, 500, "Internal Server Error");
    else response.destroy();
  });
  stream.pipe(response);
};

const handle = (request: IncomingMessage, response: ServerResponse, options: HandlerOptions): void => {
  const method = request.method ?? "GET";
  const url = request.url ?? "/";
  const failure = guardRequest(method, url, request.headers, { token: options.token, port: options.port });

  if (failure === 421) {
    sendText(response, 421, "Misdirected Request");
    return;
  }
  if (failure === 403) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  const path = pathname(url);
  if (path === "/api/health" && method === "GET") {
    sendJson(response, 200, { ok: true, service: "@musunest/studio" });
    return;
  }
  if (path === "/api" || path.startsWith("/api/")) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed");
    return;
  }

  serveStatic(request, response, options, path);
};

export function createRequestHandler(options: StudioServerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const staticDir = resolve(options.staticDir);
  const pageValues = options.pageValues ?? {};
  return (request, response) =>
    handle(request, response, {
      staticDir,
      token: options.token,
      pageValues,
      port: options.port ?? DEFAULT_PORT,
    });
}

export function createStudioServer(options: StudioServerOptions): Server {
  const staticDir = resolve(options.staticDir);
  const pageValues = options.pageValues ?? {};
  const server = createServer((request, response) => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : (options.port ?? DEFAULT_PORT);
    handle(request, response, { staticDir, token: options.token, pageValues, port });
  });
  return server;
}

export function listen(server: Server, port: number = DEFAULT_PORT): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, BIND_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolvePort(address.port);
      else reject(new Error("サーバのアドレスを読めない"));
    });
  });
}
