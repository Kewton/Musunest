// SDK の公開面（Issue #104）。host が workspace で持てる依存はこのパッケージだけなので、
// **画面が使うものがここから取れること**を確かめる（型は appspec-schema からの再公開、実体は client.ts）。

import { describe, expect, it } from "vitest";
import { INVALID_RESPONSE, NETWORK_FAILURE, PACKAGE_NAME, createMusunestClient } from "./index.js";
import type { ApiRow, ApiSpecBody, ApiValue, ApiViewBody, FieldType } from "./index.js";

/** 再公開した型が使えること（型だけの検査。実行時には何も残らない） */
const reexported: readonly [FieldType, ApiValue, ApiRow | null, ApiSpecBody | null, ApiViewBody | null] = [
  "number",
  "6600",
  null,
  null,
  null,
];

describe("@musunest/sdk の公開面", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/sdk");
  });

  it("クライアントの工場と、SDK が見つける失敗のコードを公開する", () => {
    expect(typeof createMusunestClient).toBe("function");
    expect(NETWORK_FAILURE).toBe("NETWORK_FAILURE");
    expect(INVALID_RESPONSE).toBe("INVALID_RESPONSE");
    expect(reexported[0]).toBe("number");
  });
});
