---
name: cause_investigate_log-first
description: 不具合や異常が疑われたとき、コードを読む前にまず `agentdashboard logs` の実物を採って経路（ブラウザ／サーバ／セッションホスト／パーサ）ごとに集計し、当たりを付けてから調査レポートの下書きを出す。実機（8787）は読むだけで、書き換え・再起動は一切行わない。コードは直さない。「ログから原因を調べて」「log-first で調査して」「まずログを見て当たりを付けて」で起動する。
argument-hint: "[調べたい事象や card ID]"
---

# cause_investigate_log-first

ログ優先の原因調査スキル。**手順の本体は `mainflow.md` に書いてある。まずそちらを読むこと。**

このファイルには手順を書かない（`skill_operate` の作法：SKILL.md は入口とルールだけを持つ）。

---
<br/>
<br/>

## このスキルがしないこと

- コードを直さない（段4までコードは1行も読まない。段4のあとの修正はこのスキルの範囲外）
- 実機（8787）へ書き込まない・再起動しない（`ad logs`／`ad state-dir` の読み取りだけを行う）
- `MyDocs/イシュー/` 配下のイシューへ書かない（`bin/report-draft` の既定出力先はスクラッチパッドで、実イシューの `調査レポート/` へ置くかどうかは呼ぶ側の判断）
- `.claude/skills/cause_investigate_log-first/` の外へ書かない
- コミットしない

---
<br/>
<br/>

## 自己改善ルール

- 実行中にエラー・想定外の挙動・利用者からの指摘があった場合、`memory_improvement/` 配下に改善記録を残す
- 記録先の判断は `~/.claude/CLAUDE.md` の「スキル自己改善フックへの対応ルール」に従う。**「このスキルが別プロジェクトで使われても同様に必要か」が YES なら `memory_improvement/`、NO なら PJT ガイドライン（`.claude/docs/guideline.md`）**
- `knowledge/paths.md` の経路表（proc／target／kind の対応）は実物のログから拾ったものなので、`ad logs` の出力形が変わったと分かったらその場で更新する
- 一度きりの偶発的ミスや外部要因（実機が一時的に落ちていた等）は記録の対象外
- 改善が `mainflow.md` の手順そのものに落とせる場合は、その場で反映する

---
<br/>
<br/>

## ディレクトリ構成

```
cause_investigate_log-first/
├── SKILL.md                    ← このファイル（入口）
├── mainflow.md                 ← 手順本体（§12-1〜§12-3、段0〜段4）
├── knowledge/
│   └── paths.md                ← 経路の表：ブラウザ→サーバ→セッションホスト→パーサ。proc／target／代表的な kind
├── memory_improvement/
│   └── README.md                ← 自己改善記録の書き方
└── bin/
    ├── collect                  ← 段0＋段1：running-state --json と ad logs --json を1つの作業フォルダへ落とす
    ├── narrow                   ← 段2：落とした JSON を経路ごとに集計する（--card で1枚に絞れる）
    └── report-draft              ← 段4：調査レポートの下書きを出す（ad logs --sanitize を通す）
```
