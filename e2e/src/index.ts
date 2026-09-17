// @musunest/e2e — staging の見本の採点（M1.2。Issue #110）。
//
// M0 の頃は貫通スモーク（infra/scripts/smoke.ts）だけだった。M1.2 で、host と同じ型付きクライアント
// （@musunest/sdk）を使い、staging の spec・view・action の経路を通る採点の runner を持つ。
export const PACKAGE_NAME = "@musunest/e2e" as const;

export * from "./warikan.js";
export {
  BASE_URL_ENV,
  CREDENTIAL_ENVS,
  E2eError,
  EXIT_NG,
  EXIT_OK,
  INSTANCE_ENV,
  INSTANCE_PATTERN,
  REDACTED,
  instanceOf,
  originOf,
  redact,
  runCli,
  type CliIo,
} from "./cli.js";
