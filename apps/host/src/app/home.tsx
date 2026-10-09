// ホーム（M2.1。Issue #264）——ログインの入口と、自分のアプリの一覧。**いまのホームは見出しだけだった**。
//
// この画面が決めるのは 3 つだけである。
//   1. **ログインしていなければ**「Google でログイン」を出す。押すと gateway の /auth/login へ行く
//      （host の Worker が /auth/* を gateway へ中継する。SPAシェルには落とさない）
//   2. **ログインしていれば**自分のアプリの一覧を出す。**各行はアプリの画面（/apps/<instanceId>）へのリンク**である
//   3. **LINE の中のブラウザ**（埋め込み WebView）では、外のブラウザで開き直す案内を出す——Google は
//      埋め込み WebView での OAuth を 403 `disallowed_useragent` で断る（03 §6）。LINE は
//      `openExternalBrowser=1` を付けた URL を外のブラウザで開く
//
// **ログインの有無は `GET /api/me/instances` の応答で見分ける。** ログインしていなければ data-api が
// 401 `UNAUTHENTICATED` を返す（gateway が署名付き cookie から利用者を見分ける。Issue #260・#263）。
// **画面は識別ヘッダを付けない**——付けるのは gateway だけである（なりすましを通さない）。
//
// **データはブラウザでだけ取る。** dist/client/index.html は SPAシェルだけで、この画面の中身を埋め込まない
// （src/worker/index.test.ts が確かめる）。だからこの component はブラウザ（と jsdom）でだけ描かれる。

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ApiInstanceSummary, MusunestIdentityClient } from "@musunest/sdk";

/** ログインの入口。gateway の Google OIDC（host の Worker が /auth/* を gateway へ中継する）。 */
export const LOGIN_PATH = "/auth/login" as const;

/** LINE の中で外のブラウザへ移すための query（03 §6 の `openExternalBrowser=1`）。 */
export const EXTERNAL_BROWSER_PARAM = "openExternalBrowser" as const;

/** 外のブラウザで開き直すリンクの文言（案内と揃える）。 */
export const OPEN_EXTERNAL_LABEL = "外部のブラウザで開く";

/** ログインの入口の文言（受入条件の「ログインのボタン」）。 */
export const LOGIN_LABEL = "Google でログイン" as const;

export interface HomeProps {
  readonly client: MusunestIdentityClient;
  /** いまのページの URL。LINE の中で外のブラウザへ開き直すリンクに使う */
  readonly href: string;
  /** ブラウザの User-Agent。LINE の中のブラウザの判定に使う */
  readonly userAgent: string;
}

/** ホームが取る状態。読込中・未ログイン・一覧・読めなかった、を**1つに潰さない**。 */
type HomeState =
  | { readonly kind: "loading" }
  | { readonly kind: "anonymous" }
  | { readonly kind: "listed"; readonly instances: readonly ApiInstanceSummary[] }
  | { readonly kind: "failed" };

/**
 * LINE の中のブラウザ（埋め込み WebView）か。User-Agent に `Line/<版>` が入る
 * （iOS / Android とも）。大文字小文字は問わない。
 */
export function isLineBrowser(userAgent: string): boolean {
  return /\bLine\//i.test(userAgent);
}

/** アプリの画面（`/apps/<instanceId>`）へのリンク。区切り文字は URL エンコードする。 */
export function appHref(instanceId: string): string {
  return `/apps/${encodeURIComponent(instanceId)}`;
}

/**
 * いまの URL を、外のブラウザで開き直す URL にする（`openExternalBrowser=1` を足す。03 §6）。
 * 解析できない URL でも落ちない——query を足せないときは、そのまま返す（案内を出さないより出す）。
 */
export function externalBrowserHref(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.set(EXTERNAL_BROWSER_PARAM, "1");
    return url.href;
  } catch {
    return href;
  }
}

// ── 見た目（幅 360 CSS px で横に流さない。他の画面と同じ作法） ──────────────

const SCREEN_STYLE: CSSProperties = { maxWidth: "100%", overflowWrap: "anywhere" };
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0, maxWidth: "100%" };
const ROW_STYLE: CSSProperties = {
  border: "1px solid #c9c9c9",
  borderRadius: 4,
  padding: 8,
  marginBottom: 8,
  maxWidth: "100%",
  overflowWrap: "anywhere",
};
const NOTICE_STYLE: CSSProperties = {
  border: "1px solid #c9c9c9",
  borderRadius: 4,
  padding: 8,
  marginBottom: 12,
  maxWidth: "100%",
};
const LOGIN_STYLE: CSSProperties = { display: "inline-block", minHeight: 44, padding: "12px 16px" };

export function Home({ client, href, userAgent }: HomeProps) {
  const [state, setState] = useState<HomeState>({ kind: "loading" });
  const line = isLineBrowser(userAgent);

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await client.listMyInstances();
      if (!active) return;
      if (result.ok) {
        setState({ kind: "listed", instances: result.value.instances });
        return;
      }
      // ログインしていないことは、data-api の 401 `UNAUTHENTICATED` で分かる（**D1 を読まずに断る**）。
      // ほかの失敗（通信・契約違い）は「ログインしていない」に読み替えない
      setState(result.error.code === "UNAUTHENTICATED" ? { kind: "anonymous" } : { kind: "failed" });
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <main className="home" data-state={state.kind} style={SCREEN_STYLE}>
      <h1>MUSUNEST</h1>
      {line && <LineBrowserNotice href={href} />}
      {state.kind === "loading" && <p className="home-loading">読み込んでいます…</p>}
      {state.kind === "anonymous" && (
        // **ログインの入口はボタンである**（押すと /auth/login へ行き、host の Worker が gateway へ中継する）。
        // 経路を持たせつつ、支援技術にはボタンとして見せる（`role` を上書きする。見た目もボタンにする）
        <p className="home-login">
          <a className="login" data-login={LOGIN_PATH} href={LOGIN_PATH} role="button" style={LOGIN_STYLE}>
            {LOGIN_LABEL}
          </a>
        </p>
      )}
      {state.kind === "failed" && (
        <p className="state failure" data-state="failed" role="alert">
          アプリの一覧を読み込めませんでした
        </p>
      )}
      {state.kind === "listed" && <InstanceList instances={state.instances} />}
    </main>
  );
}

/** 自分のアプリの一覧。**各行がアプリの画面（`/apps/<instanceId>`）へのリンク**である（受入条件）。 */
function InstanceList({ instances }: { readonly instances: readonly ApiInstanceSummary[] }) {
  if (instances.length === 0) {
    return (
      <p className="state empty" data-state="empty">
        まだアプリがありません
      </p>
    );
  }
  return (
    <ul className="home-instances" aria-label="自分のアプリ" style={LIST_STYLE}>
      {instances.map((instance) => (
        <li className="home-instance" data-instance={instance.instanceId} key={instance.instanceId} style={ROW_STYLE}>
          <a className="app-link" href={appHref(instance.instanceId)}>
            {instance.instanceId}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * LINE の中のブラウザで出す案内（Issue #264）。**外のブラウザで開き直すリンク**を出す——
 * `openExternalBrowser=1` を付けた URL を LINE が外のブラウザで開く（03 §6）。
 */
function LineBrowserNotice({ href }: { readonly href: string }) {
  return (
    <aside className="home-line" data-line="true" role="note" style={NOTICE_STYLE}>
      <p>
        LINE の中のブラウザでは Google にログインできません。外のブラウザで開き直してください。
      </p>
      <a className="open-external" href={externalBrowserHref(href)}>
        {OPEN_EXTERNAL_LABEL}
      </a>
    </aside>
  );
}
