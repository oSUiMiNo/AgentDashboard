---
<br/>
<br/>

## 概要表（改善案提出スキルが必ず記載）
| # | 完了ステータス | 追加日時 | 問い合わせ先セッションID | 要約 |
|---|---|---|---|---|
| 1 | [ ] | 2026-0917-1000 | fe0d452b-4983-4d7c-bd20-3513cf9352ab | 触ったファイルの記録を、セッション記録（JSONL）の後解析ではなく `PostToolUse` フックで台帳に積む方式… |
<!-- proposal_submit:summary-rows -->

---
<br/>
<br/>

## 案詳細（改善案提出スキルが必ず記載）

### 1
提案：触ったファイルの記録を、セッション記録（JSONL）の後解析ではなく `PostToolUse` フックで台帳に積む方式へ寄せる。
担当イシュー：PJTスコープに本PJT専用の開発効率化スキルを作成
背景：初版の `touched-files` は検収で4回直した——ワーカの記録（`subagents/agent-*.jsonl`）を読む・Bash 由来の雑音を落とす・`-uall` で突き合わせる・`TARGET=…; cp … "$TARGET"` の変数越しの書き込みを解決する。権限省略モードではワーカが `Write` でなくヒアドキュメントで書くため、書き方の形が増えるたびに解析が追いかけっこになる。設計 §15 で「足りなくなったら考える」と先送りしたもの。
特記事項：フックは `settings.json` の共有変更になるので `shared-scope_change_notify` を通す。
<!-- proposal_submit:detail-sections -->

---
<br/>
<br/>

## 変更ログ（PROPOSAL.md 整備スキルが本ドキュメントを更新した際に必ず記載。）
| 更新日時 | 要約 |
|---|---|
<!-- proposal_maintain:changelog-rows -->
