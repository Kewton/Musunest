// @vitest-environment jsdom
//
// ホームの component テスト（M2.1。Issue #264 の受入試験）。受入条件をそのまま確かめる。
//   1. **ログインしていない状態**（`GET /api/me/instances` が 401 `UNAUTHENTICATED`）では
//      「Google でログイン」の入口が出る。押すと gateway の /auth/login へ行く（host の Worker が中継する）
//   2. **ログインした状態**では、**一覧の各行がアプリの画面（/apps/<instanceId>）へのリンク**になる
//   3. **LINE の中のブラウザの User-Agent** では、外のブラウザで開き直すリンク（`openExternalBrowser=1`）が出る
//
// **画面は識別ヘッダを付けない。** ログインの有無は `/api/me/instances` の 401 で見分ける
// （識別を付けるのは gateway だけである。Issue #260・#263）。だから偽の client は `listMyInstances` だけを差し替える。
// LINE の中のブラウザかどうかは User-Agent で決まる（03 §6。Google は埋め込み WebView での OAuth を断る）。

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appHref,
  EXTERNAL_BROWSER_PARAM,
  externalBrowserHref,
  Home,
  isLineBrowser,
  LOGIN_LABEL,
  LOGIN_PATH,
  OPEN_EXTERNAL_LABEL,
} from "./home";
import type {
  ApiInstancesBody,
  ClientErrorCode,
  ClientResult,
  MusunestIdentityClient,
} from "@musunest/sdk";

const HREF = "https://app.musunest.example/apps/inst-1";

/** LINE の外（Safari）の User-Agent */
const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/** LINE の中のブラウザの User-Agent */
const LINE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.0.0";

const okResult = <T,>(value: T): ClientResult<T> => ({ ok: true, value });
const errResult = (code: ClientErrorCode, status: number | null): ClientResult<never> => ({
  ok: false,
  error: { status, code, fields: [], validations: [] },
});

/** 一覧の口だけを差し替えた偽の client（ほかの口はこの画面では使わない） */
function clientWith(listMyInstances: MusunestIdentityClient["listMyInstances"]): MusunestIdentityClient {
  return {
    listMyInstances,
    getSpec: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    getView: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    addRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    deleteRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
    setRecord: () => Promise.resolve(errResult("SPEC_UNAVAILABLE", 503)),
  };
}

/** ログインしていない（data-api が 401 `UNAUTHENTICATED` を返す） */
const anonymousClient = (): MusunestIdentityClient =>
  clientWith(() => Promise.resolve(errResult("UNAUTHENTICATED", 401)));

/** ログインしている（その利用者の Community のインスタンスの並びが返る） */
const signedInClient = (instanceIds: readonly string[]): MusunestIdentityClient =>
  clientWith(() =>
    Promise.resolve(
      okResult<ApiInstancesBody>({ instances: instanceIds.map((instanceId) => ({ instanceId })) }),
    ),
  );

async function renderHome(
  client: MusunestIdentityClient,
  options: { readonly href?: string; readonly userAgent?: string } = {},
) {
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      createElement(Home, {
        client,
        href: options.href ?? HREF,
        userAgent: options.userAgent ?? SAFARI_UA,
      }),
    );
  });
  if (rendered === undefined) throw new Error("render できなかった");
  return rendered;
}

afterEach(cleanup);

describe("ログインの入口（受入条件）", () => {
  it("ログインしていなければ Google でログインのボタンが出る", async () => {
    await renderHome(anonymousClient());

    const login = await screen.findByRole("button", { name: LOGIN_LABEL });
    // 押すと gateway の /auth/login へ行く（host の Worker が /auth/* を SPAシェルに落とさず中継する）
    expect(login.getAttribute("href")).toBe(LOGIN_PATH);
    // ログインしていないので一覧は出ない
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("ログインしていなければ、一覧の行のリンクは出ない", async () => {
    const { container } = await renderHome(anonymousClient());
    await screen.findByRole("button", { name: LOGIN_LABEL });
    expect(container.querySelectorAll("a.app-link")).toHaveLength(0);
  });

  it("ログインの有無は /api/me/instances の 401 で見分ける（画面は識別ヘッダを付けない）", async () => {
    const listMyInstances = vi.fn<MusunestIdentityClient["listMyInstances"]>(() =>
      Promise.resolve(errResult("UNAUTHENTICATED", 401)),
    );
    await renderHome(clientWith(listMyInstances));

    await screen.findByRole("button", { name: LOGIN_LABEL });
    expect(listMyInstances).toHaveBeenCalledTimes(1);
    expect(listMyInstances).toHaveBeenCalledWith();
  });
});

describe("自分のアプリの一覧（受入条件）", () => {
  it("ログインしていれば、一覧の各行がアプリの画面へのリンクになる", async () => {
    const { container } = await renderHome(signedInClient(["inst-1", "inst-2"]));

    const links = await screen.findAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/apps/inst-1", "/apps/inst-2"]);
    // **アプリの画面へのリンク**である（受入条件）。行の数だけある
    for (const id of ["inst-1", "inst-2"]) {
      expect(container.querySelector(`a[href="${appHref(id)}"]`)).not.toBeNull();
    }
    // ログインしているので、ログインの入口は出ない
    expect(screen.queryByRole("button", { name: LOGIN_LABEL })).toBeNull();
  });

  it("アプリが 1 つも無ければ、空の状態を出す", async () => {
    const { container } = await renderHome(signedInClient([]));

    await screen.findByText("まだアプリがありません");
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("一覧を読めなかったら（401 以外）、ログインの入口に読み替えない", async () => {
    const { container } = await renderHome(
      clientWith(() => Promise.resolve(errResult("NETWORK_FAILURE", null))),
    );

    await screen.findByText("アプリの一覧を読み込めませんでした");
    expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: LOGIN_LABEL })).toBeNull();
  });
});

describe("LINE の中のブラウザ（受入条件）", () => {
  it("LINE の User-Agent では、外のブラウザで開き直すリンクが出る", async () => {
    const { container } = await renderHome(anonymousClient(), { userAgent: LINE_UA });

    const open = await screen.findByRole("link", { name: OPEN_EXTERNAL_LABEL });
    // `openExternalBrowser=1` を付けた、いまの URL である（LINE が外のブラウザで開く）
    expect(open.getAttribute("href")).toBe(externalBrowserHref(HREF));
    expect(new URL(open.getAttribute("href") ?? "").searchParams.get(EXTERNAL_BROWSER_PARAM)).toBe("1");
    expect(container.querySelector('[data-line="true"]')).not.toBeNull();
  });

  it("LINE の外のブラウザでは、外のブラウザで開き直す案内を出さない", async () => {
    const { container } = await renderHome(anonymousClient(), { userAgent: SAFARI_UA });

    await screen.findByRole("button", { name: LOGIN_LABEL });
    expect(container.querySelector('[data-line="true"]')).toBeNull();
    expect(screen.queryByRole("link", { name: OPEN_EXTERNAL_LABEL })).toBeNull();
  });
});

describe("User-Agent の判定と URL の組み立て", () => {
  it("`Line/` の形の User-Agent だけを LINE の中のブラウザと見なす", () => {
    expect(isLineBrowser(LINE_UA)).toBe(true);
    expect(isLineBrowser("Line/14.0.0")).toBe(true);
    expect(isLineBrowser(SAFARI_UA)).toBe(false);
    expect(isLineBrowser("")).toBe(false);
    // 無関係な語（timeline の line）に反応しない
    expect(isLineBrowser("Mozilla/5.0 timeline/1.0")).toBe(false);
  });

  it("外のブラウザで開く URL は、いまの URL に openExternalBrowser=1 を足したものである", () => {
    expect(externalBrowserHref("https://app.example/")).toBe("https://app.example/?openExternalBrowser=1");
    expect(externalBrowserHref("https://app.example/x?a=1")).toBe(
      "https://app.example/x?a=1&openExternalBrowser=1",
    );
    // 解析できない URL でも落ちない（そのまま返す）
    expect(externalBrowserHref("not a url")).toBe("not a url");
  });

  it("アプリの画面へのリンクは、区切り文字を URL エンコードする", () => {
    expect(appHref("inst-1")).toBe("/apps/inst-1");
    expect(appHref("a/b c")).toBe("/apps/a%2Fb%20c");
  });
});
