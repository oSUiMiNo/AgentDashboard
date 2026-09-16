---
name: issue-close_verify
description: イシュー（またはイシューグループ）を閉じる前に、文書と実態の突き合わせ・回帰台帳の下書きと「戻すと落ちる」検査・配る版の検査を行い、閉じてよいか（OK）と足りない点（不足）を判定する。実装・クローズ処理・台帳への書き込みは一切行わない。「このイシュー閉じていい？」「issue-close_verify かけて」「クローズ前チェックして」で起動する。
argument-hint: "<イシューまたはイシューグループのパス>"
---

# issue-close_verify

イシューを閉じる前の検収スキル。**手順の本体は `mainflow.md` に書いてある。まずそちらを読むこと。**

このファイルには手順を書かない（`skill_operate` の作法：SKILL.md は入口とルールだけを持つ）。

---
<br/>
<br/>

## このスキルがしないこと

- イシューを閉じない（クローズレポート.md の作成・`クローズ/` への移動はしない）
- 回帰台帳（`regressions.toml`）へ書き込まない（下書きの印字までで、書くのは閉じる本人）
- 共有ツリー（`$HOME/Dev/AgentDashboard`）に対して `git stash`／`git checkout`／`git reset`／`git commit` を行わない
- `make ci`・`make build-web build-debug` などの重いビルドを、明示的に頼まれた「戻すと落ちる」検査（`--dry-run` を外したとき）以外では実行しない
- 実装や修正は行わない。判定と不足点の報告のみを行う

---
<br/>
<br/>

## 自己改善ルール

- 実行中にエラー・想定外の挙動・利用者からの指摘があった場合、`memory_improvement/` 配下に改善記録を残す
- 既存ドキュメントに該当する記載がある場合は新規作成ではなく既存を更新する
- 一度きりの偶発的ミスや外部要因は更新の対象外
- 改善が `mainflow.md` の手順そのものに落とせる場合は、その場で反映する

---
<br/>
<br/>

## ディレクトリ構成

```
issue-close_verify/
├── SKILL.md                    ← このファイル（入口）
├── mainflow.md                 ← 手順本体（§9-1〜§9-5）
├── knowledge/
│   └── why-not-red.md          ← 「戻すと落ちる」検査で赤くならなかったときに疑う順序
├── memory_improvement/
│   └── README.md                ← 自己改善記録の書き方
└── bin/
    ├── check-docs               ← §9-2：文書と実態の突き合わせ
    ├── ledger-lookup             ← §9-3 手順1：回帰台帳の下書き
    └── revert-check              ← §9-3 手順3〜6：「戻すと落ちる」検査
```
