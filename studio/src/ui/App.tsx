// 画面の殻。見出しと「新しく作る」「履歴」の2つの入口だけを置く。
// 宣言の用語（entity・computed・view・action）は画面の文言に出さない。
export function App() {
  return (
    <main className="studio">
      <header className="studio__header">
        <p className="studio__eyebrow">手元の工房</p>
        <h1 className="studio__title">MUSUNEST</h1>
        <p className="studio__lead">依頼を言葉で書いて、質問に答えて、作ったものを見る。</p>
      </header>
      <nav className="studio__entries" aria-label="入口">
        <button type="button" className="studio__entry studio__entry--primary">
          新しく作る
        </button>
        <button type="button" className="studio__entry">
          履歴
        </button>
      </nav>
    </main>
  );
}
