// 画面の HTML の差し込み口。後の Issue は値を足すだけで、HTML を触らない。
// `{{NAME}}` を値で置き換える。値は HTML の属性として逃がす。値を渡していない名前は空にする。
const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => HTML_ESCAPES[character] ?? character);
}

export function renderPage(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => escapeHtmlAttribute(values[name] ?? ""));
}
