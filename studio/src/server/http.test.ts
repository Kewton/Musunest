import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIND_HOST, createStudioServer, listen } from "./http.js";

const TOKEN = "test-token";
const STAGING = "https://staging.example";

interface Response {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

let staticDir: string;
let server: ReturnType<typeof createStudioServer>;
let port: number;

const call = (path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<Response> =>
  new Promise((resolveResponse, reject) => {
    const request = httpRequest(
      {
        host: BIND_HOST,
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

const host = (): string => `${BIND_HOST}:${port}`;

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), "musunest-studio-"));
  writeFileSync(
    join(staticDir, "index.html"),
    '<!doctype html><meta name="studio-token" content="{{STUDIO_TOKEN}}" /><meta name="studio-staging-origin" content="{{STUDIO_STAGING_ORIGIN}}" />',
  );
  writeFileSync(join(staticDir, "app.js"), "globalThis.STUDIO = true;");

  server = createStudioServer({
    staticDir,
    token: TOKEN,
    pageValues: { STUDIO_TOKEN: TOKEN, STUDIO_STAGING_ORIGIN: STAGING },
  });
  port = await listen(server, 0);
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(staticDir, { recursive: true, force: true });
});

describe("binding", () => {
  it("127.0.0.1 にだけ bind する", () => {
    const address = server.address();
    expect(typeof address).toBe("object");
    if (typeof address === "object" && address !== null) {
      expect(address.address).toBe("127.0.0.1");
      expect(address.family).toBe("IPv4");
    }
  });
});

describe("API", () => {
  it("正しい要求の GET /api/health は 200", async () => {
    const response = await call("/api/health", { headers: { host: host(), "x-studio-token": TOKEN } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, service: "@musunest/studio" });
  });

  it("合言葉の無い /api/ は 403", async () => {
    const response = await call("/api/health", { headers: { host: host() } });
    expect(response.status).toBe(403);
  });

  it("合言葉の違う /api/ は 403", async () => {
    const response = await call("/api/health", { headers: { host: host(), "x-studio-token": "wrong" } });
    expect(response.status).toBe(403);
  });

  it("知らない /api/ は 404", async () => {
    const response = await call("/api/unknown", { headers: { host: host(), "x-studio-token": TOKEN } });
    expect(response.status).toBe(404);
  });
});

describe("Host の照合", () => {
  it("Host が違えば API は 421", async () => {
    const response = await call("/api/health", { headers: { host: "evil.example", "x-studio-token": TOKEN } });
    expect(response.status).toBe(421);
  });

  it("Host が違えば GET /（HTML）も 421", async () => {
    const response = await call("/", { headers: { host: "evil.example" } });
    expect(response.status).toBe(421);
  });

  it("Host が違えば静的ファイルも 421", async () => {
    const response = await call("/app.js", { headers: { host: "evil.example" } });
    expect(response.status).toBe(421);
  });
});

describe("Origin の照合", () => {
  it("Origin の無い POST は 403", async () => {
    const response = await call("/api/health", { method: "POST", headers: { host: host(), "x-studio-token": TOKEN } });
    expect(response.status).toBe(403);
  });

  it("Origin の違う POST は 403", async () => {
    const response = await call("/api/health", {
      method: "POST",
      headers: { host: host(), "x-studio-token": TOKEN, origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("Origin の正しい POST は 403 で止めない", async () => {
    const response = await call("/api/health", {
      method: "POST",
      headers: { host: host(), "x-studio-token": TOKEN, origin: `http://${host()}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("画面と静的ファイル", () => {
  it("HTML の差し込み口が合言葉を埋める", async () => {
    const response = await call("/", { headers: { host: host() } });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain(`content="${TOKEN}"`);
    expect(response.body).toContain(`content="${STAGING}"`);
    expect(response.body).not.toContain("{{STUDIO_TOKEN}}");
  });

  it("静的ファイルを返す", async () => {
    const response = await call("/app.js", { headers: { host: host() } });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.body).toBe("globalThis.STUDIO = true;");
  });

  it("無い静的ファイルは 404", async () => {
    const response = await call("/missing.js", { headers: { host: host() } });
    expect(response.status).toBe(404);
  });

  it("静的ファイルの外へ出る要求は 403", async () => {
    const response = await call("/../package.json", { headers: { host: host() } });
    expect(response.status).toBe(403);
  });
});
