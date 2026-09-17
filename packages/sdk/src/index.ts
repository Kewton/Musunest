// @musunest/sdk — データ・通知への唯一の扉
//
// M1.1 で、data-api の HTTP 契約（packages/appspec-schema/src/api.ts）を呼ぶ型付きクライアントを持つ（Issue #104）。
// **共通の型は appspec-schema から再公開する。** host が workspace で持てる依存はこのパッケージだけなので
// （CLAUDE.md「依存の向き」）、画面が読む型（ApiSpecBody など）はここから取れるようにしておく。

export const PACKAGE_NAME = "@musunest/sdk" as const;

export * from "./client.js";

// **宣言の読み取り（項目の種類と参照先）も、ここから出す。** 画面（host）が workspace で参照できるのは
// このパッケージだけなので（CLAUDE.md「依存の向き」）、画面が使う関数を appspec-schema から再輸出する。
export { fieldKind, fieldTarget } from "@musunest/appspec-schema";

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
  ApiTransfer,
  ApiValue,
  ApiViewBody,
  AppSpec,
  Computed,
  Entity,
  FieldDeclaration,
  FieldKind,
  FieldType,
  NormalizedAppSpec,
  Permission,
  RefFieldDeclaration,
  RefListFieldDeclaration,
  Validation,
  View,
  ViewType,
} from "@musunest/appspec-schema";
