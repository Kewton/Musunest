import { describe, expect, it } from "vitest";
import { escapeHtmlAttribute, renderPage } from "./page.js";

describe("renderPage", () => {
  it("名前付きの値を埋める", () => {
    const html = renderPage('<meta name="studio-token" content="{{STUDIO_TOKEN}}" />', { STUDIO_TOKEN: "abc123" });
    expect(html).toBe('<meta name="studio-token" content="abc123" />');
  });

  it("引用符・山括弧・アンパサンドを属性として逃がす", () => {
    const html = renderPage('<div data-value="{{VALUE}}"></div>', { VALUE: `a"b<c>'d&e` });
    expect(html).toBe('<div data-value="a&quot;b&lt;c&gt;&#39;d&amp;e"></div>');
  });

  it("値が無い名前は空にする", () => {
    expect(renderPage('<div data-value="{{MISSING}}"></div>', {})).toBe('<div data-value=""></div>');
  });

  it("同じ名前をすべて置き換える", () => {
    expect(renderPage("{{A}}/{{A}}", { A: "x" })).toBe("x/x");
  });

  it("escapeHtmlAttribute は単体でも使える", () => {
    expect(escapeHtmlAttribute("<&>\"'")).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
