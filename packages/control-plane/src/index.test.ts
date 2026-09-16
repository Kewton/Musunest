// control-plane パッケージの受入試験（#100）。公開面と、失敗の分け方を固定する。
//
// 読み書きの中身（束縛引数・冪等・競合・伝播）は src/registry.test.ts、migration は
// src/migration.test.ts が確かめる。ここは「何を公開しているか」だけを見る。
import { describe, expect, it } from "vitest";
import {
  APP_INSTANCES_TABLE,
  APPS_TABLE,
  PACKAGE_NAME,
  REGISTRY_ERROR_CODES,
  RegistryError,
  getApp,
  getInstance,
  registerApp,
  registerInstance,
  resolveInstanceApp,
} from "./index.js";

describe("control-plane パッケージ", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/control-plane");
  });

  it("登録表の名前を公開する（SQL と migration が同じ1か所を見る）", () => {
    expect([APPS_TABLE, APP_INSTANCES_TABLE]).toEqual(["apps", "app_instances"]);
  });

  it("アプリ・インスタンスの登録、取得、解決を公開する", () => {
    for (const fn of [registerApp, getApp, registerInstance, getInstance, resolveInstanceApp]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("失敗はコードで分ける（呼ぶ側が例外の文言に依存しない）", () => {
    expect(REGISTRY_ERROR_CODES).toEqual(["app_conflict", "instance_conflict", "app_not_found"]);

    const error = new RegistryError("app_not_found", "未登録のアプリを指すインスタンスは登録できない");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RegistryError");
    expect(error.code).toBe("app_not_found");
    expect(error.message).toBe("未登録のアプリを指すインスタンスは登録できない");
  });
});
