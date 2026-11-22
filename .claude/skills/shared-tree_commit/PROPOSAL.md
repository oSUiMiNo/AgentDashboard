---
<br/>
<br/>

## 概要表（改善案提出スキルが必ず記載）
| # | 完了ステータス | 追加日時 | 問い合わせ先セッションID | 要約 |
|---|---|---|---|---|
| 1 | [ ] | 2026-0917-1000 | fe0d452b-4983-4d7c-bd20-3513cf9352ab | 触ったファイルの記録を、セッション記録（JSONL）の後解析ではなく `PostToolUse` フックで台帳に積む方式… |
| 2 | [ ] | 2026-0917-1308 | fe0d452b-4983-4d7c-bd20-3513cf9352ab | touched-files がセッション記録を読むときの null バイト警告を消す |
| 3 | [ ] | 2026-1123-0247 | a39c3ae7-f960-4b17-a49c-fce88c4be0df | fork のワーカがコミットするときの道を mainflow に書く（または touched-files に fork … |
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

### 2
提案：touched-files がセッション記録を読むときの null バイト警告を消す
担当イシュー：PJTスコープに本PJT専用の開発効率化スキルを作成
背景：実行すると line 236: warning: command substitution: ignored null byte in input が2行出る。結果は正しいが、使うたびに警告が出ると「壊れている」と読まれる。
特記事項：無し

### 3
提案：fork のワーカがコミットするときの道を mainflow に書く（または touched-files に fork の記録〈tasks/<id>.output〉を読ませる口を足す）。いまの Phase 1 はセッション記録（親の .jsonl）から触ったファイルを引く前提で、fork の編集はそこに載らないので、fork のワーカは毎回『git diff のハンクの位置が自分の編集だけかを見て git commit -- <パス>』の手を自分で組み立てている
担当イシュー：ファイル閲覧の上限を設定から変え、大きいものは流し読みする
背景：フェーズ1・2の実行ワーカ（どちらも fork）が、Phase 1 の sonnet 委譲を使わずに計画.md の『コミット（2）の注意』の手でコミットした。手順はイシューの計画.md にしか書かれておらず、別のイシューの fork は同じ判断を毎回し直すことになる
特記事項：fork の中からは sonnet のワーカを起こせても、fork 自身の編集の記録の場所を touched-files が知らない。PROPOSAL #1（PostToolUse フックで台帳に積む方式）が入れば fork の編集も拾える可能性があり、そちらと合わせて判断するとよい
<!-- proposal_submit:detail-sections -->

---
<br/>
<br/>

## 変更ログ（PROPOSAL.md 整備スキルが本ドキュメントを更新した際に必ず記載。）
| 更新日時 | 要約 |
|---|---|
<!-- proposal_maintain:changelog-rows -->
