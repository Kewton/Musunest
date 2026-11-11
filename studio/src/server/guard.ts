import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// 手元の工房の守り（studio-s1.md §8）。
//   - Host は 127.0.0.1 / localhost の当該ポートだけ。違えば全部の要求（HTML・静的ファイルを含む）を 421。
//     DNS rebinding で画面の合言葉が抜けないように、API だけに掛けない。
//   - `/api/` は起動ごとの合言葉のヘッダが一致しないと 403。
//   - POST は Origin が同じでなければ 403。Origin の無い POST も 403。
export const TOKEN_HEADER = "x-studio-token";
export const API_PREFIX = "/api/";
export const ALLOWED_HOSTS = ["127.0.0.1", "localhost"] as const;

export interface GuardContext {
  token: string;
  port: number;
}

export type GuardFailure = 403 | 421;

export function createToken(): string {
  return randomBytes(32).toString("hex");
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const actual = host.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => actual === `${allowed}:${port}`);
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  const actual = origin.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => actual === `http://${allowed}:${port}`);
}

export function tokenMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function pathname(url: string): string {
  return url.split("?")[0] ?? "/";
}

export function guardRequest(method: string, url: string, headers: IncomingHttpHeaders, context: GuardContext): GuardFailure | null {
  if (!isAllowedHost(headerValue(headers, "host"), context.port)) return 421;

  const path = pathname(url);
  if (path === "/api" || path.startsWith(API_PREFIX)) {
    if (!tokenMatches(context.token, headerValue(headers, TOKEN_HEADER))) return 403;
  }

  if (method === "POST" && !isAllowedOrigin(headerValue(headers, "origin"), context.port)) return 403;

  return null;
}
