import { describe, expect, it } from "vitest";
import { guardRequest, isAllowedHost, isAllowedOrigin, tokenMatches } from "./guard.js";

const PORT = 4318;
const TOKEN = "correct-token";

describe("isAllowedHost", () => {
  it("127.0.0.1 と localhost の当該ポートだけを通す", () => {
    expect(isAllowedHost(`127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isAllowedHost(`localhost:${PORT}`, PORT)).toBe(true);
  });

  it("別のホスト・別のポート・IPv6・Host 無しは通さない", () => {
    expect(isAllowedHost(`127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(isAllowedHost("evil.example", PORT)).toBe(false);
    expect(isAllowedHost(`[::1]:${PORT}`, PORT)).toBe(false);
    expect(isAllowedHost(undefined, PORT)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("同じオリジンだけを通す", () => {
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`, PORT)).toBe(true);
    expect(isAllowedOrigin(`http://localhost:${PORT}`, PORT)).toBe(true);
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(isAllowedOrigin("https://evil.example", PORT)).toBe(false);
    expect(isAllowedOrigin(undefined, PORT)).toBe(false);
  });
});

describe("tokenMatches", () => {
  it("一致・不一致・長さ違い・空を区別する", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, "wrong-token")).toBe(false);
    expect(tokenMatches(TOKEN, "short")).toBe(false);
    expect(tokenMatches(TOKEN, undefined)).toBe(false);
  });
});

describe("guardRequest", () => {
  const host = `127.0.0.1:${PORT}`;

  it("Host が違えば、静的ファイル・HTML・API のどれも 421", () => {
    expect(guardRequest("GET", "/", { host: "evil.example" }, { token: TOKEN, port: PORT })).toBe(421);
    expect(guardRequest("GET", "/app.js", { host: "evil.example" }, { token: TOKEN, port: PORT })).toBe(421);
    expect(guardRequest("GET", "/api/health", { host: "evil.example", "x-studio-token": TOKEN }, { token: TOKEN, port: PORT })).toBe(421);
  });

  it("合言葉の無い・違う /api/ は 403", () => {
    expect(guardRequest("GET", "/api/health", { host }, { token: TOKEN, port: PORT })).toBe(403);
    expect(guardRequest("GET", "/api/health", { host, "x-studio-token": "wrong" }, { token: TOKEN, port: PORT })).toBe(403);
    expect(guardRequest("GET", "/api/health", { host, "x-studio-token": TOKEN }, { token: TOKEN, port: PORT })).toBeNull();
  });

  it("/api/ の外の GET は合言葉を要らない", () => {
    expect(guardRequest("GET", "/", { host }, { token: TOKEN, port: PORT })).toBeNull();
  });

  it("Origin の違う POST・Origin の無い POST は 403", () => {
    const headers = { host, "x-studio-token": TOKEN };
    expect(guardRequest("POST", "/api/health", headers, { token: TOKEN, port: PORT })).toBe(403);
    expect(guardRequest("POST", "/api/health", { ...headers, origin: "https://evil.example" }, { token: TOKEN, port: PORT })).toBe(403);
    expect(guardRequest("POST", "/api/health", { ...headers, origin: `http://127.0.0.1:${PORT}` }, { token: TOKEN, port: PORT })).toBeNull();
  });
});
