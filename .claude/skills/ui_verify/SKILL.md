---
name: ui_verify
description: 見た目に関わる変更（画面・アイコン・レイアウト）を DESIGN.md の天井・床・§34 レビュー・8状態の観点で検収する。実装・修正は行わず、判定と不足点の報告のみを行う。「UIを確認して」「見た目を検収して」「DESIGN.md に沿っているか見て」で起動する。
argument-hint: "<触った画面/ファイルのパス...>"
---

# ui_verify

見た目の検収スキル。**手順の本体は `mainflow.md` に書いてある。まずそちらを読むこと。**

このファイルには手順を書かない（`skill_operate` の作法：SKILL.md は入口とルールだけを持つ）。

---
<br/>
<br/>

## 自己改善ルール

- 発火条件（このスキル自身の動作・判定基準に問題があったとき）
    - 実行中にエラー・想定外の挙動が起きたとき
    - 利用者から指摘・修正依頼を受けたとき
    - 外部ツール（`sandbox-dashboard`・`our-servers`・`browser_operate`）の挙動が変わったと分かったとき
- 発火しない場合：仕様どおりに動いたのに、単発の操作ミス（手順を1つ飛ばした等）をしただけのとき
- 記録先の判断は `~/.claude/CLAUDE.md` の「スキル自己改善フックへの対応ルール」に従う。**「このスキルが別プロジェクトで使われても同様に必要か」が YES なら `memory_improvement/`、NO なら PJT ガイドライン（`.claude/docs/guideline.md`）**
- 記録の形式・書き方は `memory_improvement/README.md` を参照

---
<br/>
<br/>

## ディレクトリ構成

```
.claude/skills/ui_verify/
├── SKILL.md                     # このファイル（入口）
├── mainflow.md                  # 8フェーズの検収手順（本体）
├── memory_improvement/
│   └── README.md                # 自己改善の記録先・書き方
├── knowledge/
│   ├── eight-states.md          # 8状態の作り方（順序が重要）
│   └── checklist.md             # DESIGN.md §34・§8 の書き写し（記入用）
└── bin/
    ├── design-sections          # 触った画面から読むべき DESIGN.md の節番号・行番号を出す
    ├── capture-plan              # 撮るべき4枚のURL・保存名を出す（撮影自体は browser_operate に委譲）
    └── violations-recorded       # §35.1「記録された違反」を数える
```
