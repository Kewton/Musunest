// @musunest/sdk — データ・通知への唯一の扉
//
// M1.1 で、data-api の HTTP 契約（packages/appspec-schema/src/api.ts）を呼ぶ型付きクライアントを持つ（Issue #104）。
// **共通の型は appspec-schema から再公開する。** host が workspace で持てる依存はこのパッケージだけなので
// （CLAUDE.md「依存の向き」）、画面が読む型（ApiSpecBody など）はここから取れるようにしておく。

export const PACKAGE_NAME = "@musunest/sdk" as const;

export * from "./client.js";

export type {
  Action,
  ApiActionRef,
  ApiCreatedBody,
  ApiErrorBody,
  ApiErrorCode,
  ApiFailureBody,
  ApiPermissions,
  ApiRejectedBody,
  ApiRow,
  ApiSpecBody,
  ApiValue,
  ApiViewBody,
  AppSpec,
  Computed,
  Entity,
  FieldType,
  NormalizedAppSpec,
  Permission,
  Validation,
  View,
} from "@musunest/appspec-schema";
