// 公開の画面（Issue #870 の目的・2・5）。公開の要求を 1 回だけ送り、公開済みなら
// インスタンス ID と「開いて試す」を出す。リンクは、応答の経路と HTML に埋めたオリジンの
// 両方があるときだけ組む。失敗は、止まった門の段を利用者の言葉で出す（値・URL を出さない）。
import { useEffect, useRef } from "react";
import type { PublishRecord, PublishSuccessRecord } from "../../shared/api";

/** 止まった門の段の、利用者の言葉。知らない段は「公開の準備」にする */
const STAGE_LABELS: Record<string, string> = {
  request: "依頼の受け取り",
  manifest: "納品物の照合",
  pins: "見本との比較",
  plan: "確定した仕様の確認",
  acceptance: "受け入れの確認",
  declaration: "内容の点検",
  publish: "公開先への反映",
  community: "公開先の登録",
};

export function stageLabelOf(stage: string | null): string {
  if (stage === null) return "公開の準備";
  return STAGE_LABELS[stage] ?? "公開の準備";
}

/**
 * 「開いて試す」の行き先を組む。オリジンは HTML に埋めた値、経路は公開の応答の後半だけを使う。
 * どちらかが無い・オリジンが http(s) でないときは null（リンクを出さない）。
 * **組んだ値は href の中だけで使う**（画面の文には出さない。禁止事項）。
 */
export function composeTryUrl(
  origin: string | null | undefined,
  path: string | null | undefined,
): string | null {
  if (typeof origin !== "string" || typeof path !== "string") return null;
  const trimmed = origin.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\/[^\s]+$/u.test(trimmed)) return null;
  if (path === "") return null;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${suffix}`;
}

export interface PublishPanelProps {
  readonly publish?: PublishRecord | null;
  readonly publishing?: boolean;
  readonly error?: string | null;
  /** HTML に埋めた staging のオリジン（無ければ null） */
  readonly origin?: string | null;
  readonly onPublish: () => void | Promise<void>;
  /** 試験で「連打しても 1 回」を測るための口。既定は「公開する」 */
  readonly label?: string;
}

function tryUrlOf(record: PublishSuccessRecord, origin: string | null | undefined): string | null {
  return composeTryUrl(origin, record.path);
}

export function PublishPanel({
  publish = null,
  publishing = false,
  error = null,
  origin = null,
  onPublish,
  label = "公開する",
}: PublishPanelProps) {
  // 連打しても公開の要求を 1 回だけにする（状態の反映を待たずに押されても止める）
  const requested = useRef(false);

  // 通信の失敗のあとは、もう一度押せるようにする（連打の抑えは解かない）
  useEffect(() => {
    if (error !== null) requested.current = false;
  }, [error]);

  const requestPublish = (): void => {
    if (requested.current || publishing) return;
    requested.current = true;
    void onPublish();
  };

  const success = publish !== null && publish.ok ? publish : null;
  const failure = publish !== null && !publish.ok ? publish : null;
  const url = success === null ? null : tryUrlOf(success, origin);

  if (success !== null) {
    return (
      <section className="block" aria-labelledby="publish-done-title">
        <h3 className="block__title" id="publish-done-title">
          公開しました
        </h3>
        <p className="publish__instance">
          インスタンス ID: <span className="publish__id">{success.instanceId}</span>
        </p>
        {url === null ? (
          <p className="block__empty">この環境ではリンクを組めません。</p>
        ) : (
          <div className="page__actions">
            <a className="button button--primary" href={url} target="_blank" rel="noreferrer noopener">
              開いて試す
            </a>
          </div>
        )}
      </section>
    );
  }

  if (failure !== null) {
    return (
      <section className="block" aria-labelledby="publish-failed-title">
        <h3 className="block__title" id="publish-failed-title">
          公開できませんでした
        </h3>
        <p className="block__empty">
          「{stageLabelOf(failure.stage)}」の段で止まりました。内容を直して、もう一度試してください。
        </p>
      </section>
    );
  }

  return (
    <section className="block" aria-labelledby="publish-title">
      <h3 className="block__title" id="publish-title">
        公開
      </h3>
      <p className="block__empty">staging の手元の場所に公開します。公開したものは URL を知る人なら開けます。</p>
      {error === null ? null : (
        <p className="page__warning" role="alert">
          {error}
        </p>
      )}
      <div className="page__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={publishing}
          onClick={requestPublish}
        >
          {publishing ? "公開しています…" : label}
        </button>
      </div>
    </section>
  );
}
