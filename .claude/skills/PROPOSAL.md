---
<br/>
<br/>

## 概要表（改善案提出スキルが必ず記載）
| # | 完了ステータス | 追加日時 | 問い合わせ先セッションID | 要約 |
|---|---|---|---|---|
| 1 | [ ] | 2026-0917-1000 | fe0d452b-4983-4d7c-bd20-3513cf9352ab | ワーカ（Sonnet）への依頼文の定型「読む量の上限」を `_shared/templates/worker-limit… |
<!-- proposal_submit:summary-rows -->

---
<br/>
<br/>

## 案詳細（改善案提出スキルが必ず記載）

### 1
提案：ワーカ（Sonnet）への依頼文の定型「読む量の上限」を `_shared/templates/worker-limits.md` として置き、各スキルの `mainflow.md` から参照する。
担当イシュー：PJTスコープに本PJT専用の開発効率化スキルを作成
背景：初回実装で計5体が大きいファイルの丸読みで文脈溢れ（autocompact thrashing）を起こして落ちた。落とした素材は `いま動いているもの.html`（51KB・1行）・`_イシューの見取り図.json`（98KB）・`CHANGELOG.md`（886行）・`Cargo.lock`・`~/.claude/coord/*/台帳.md`（131KB）。「全出力に `| head -30`」「開いてはいけないファイルの名指し」「1体の仕事は bin 3本以下」の3つを書いてからは中断ゼロ。
特記事項：無し
<!-- proposal_submit:detail-sections -->

---
<br/>
<br/>

## 変更ログ（PROPOSAL.md 整備スキルが本ドキュメントを更新した際に必ず記載。）
| 更新日時 | 要約 |
|---|---|
<!-- proposal_maintain:changelog-rows -->
