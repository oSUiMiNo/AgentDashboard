---
name: proposal_submit
description: 作業の合間や稼働終了前に見つかった改善案を PROPOSAL.md へ追記する。「改善案を出して」「これは提案として残して」「PROPOSAL.md に書いて」のような依頼、または段1の軽い振り返りで改善の種が見つかったときに使う。既存のスキルへの提案ならそのスキル自身の PROPOSAL.md へ、無ければ .claude/skills/PROPOSAL.md へ書く。
argument-hint: "[何を提案するか]"
---

# proposal_submit

改善案を・出す スキル。作業中に気づいた改善の種を、その場で直さずに `PROPOSAL.md` へ1件の提案として書き残す。

---
<br/>
<br/>

## 何をするスキルか
このスキルは**今すぐ直すためのものではない**。「直したほうがいいが、いま着手すると本題からそれる」「担当外のスキルに関わる」といった改善の種を、後で誰か（人か別セッション）が拾えるように記録する。

書き先は2種類ある。

| 書き先 | 条件 |
|---|---|
| 提案先スキル自身の `PROPOSAL.md`（例：`.claude/skills/<スキル名>/PROPOSAL.md`） | 提案の内容が既存のどれか1つのスキルの話だと分かるとき |
| `.claude/skills/PROPOSAL.md` | 特定のスキルに絞れない、PJT 横断の話のとき |

**どちらか一方にしか書かない。** 両方に書くと同じ提案が2箇所に残り、後で読む人がどちらが正か迷う。

宛先の `PROPOSAL.md` が無いときは、このスキルが `_shared/templates/PROPOSAL.md` から作る（`.claude/skills/PROPOSAL.md` 自体も、各スキルの `PROPOSAL.md` も、無いときは作らない——作るのはこのスキルが初めて書き込む瞬間だけ）。

---
<br/>
<br/>

## 手順
詳しい手順は `mainflow.md` を見よ。ここでは全体像だけを示す。

1. 段1：fork で軽く振り返り、他に見落としている改善の種が無いか確認する（無ければ「無し」で終わる。これが多数派の結果でよい）
2. 段2：書き先を決める（既存スキルの話か、PJT 横断の話か）
3. 段3：`bin/append-proposal` を worker（`subagent_type: "general-purpose"`、`model: "sonnet"`）に実行させ、追記する

---
<br/>
<br/>

## ディレクトリ構成
```
proposal_submit/
├── SKILL.md               このファイル
├── mainflow.md             段1〜段3の詳細手順
├── memory_improvement/
│   └── README.md          自己進化の記録先（このスキル自身の動作・ルーティングの問題を書く）
└── bin/
    └── append-proposal     実際に PROPOSAL.md へ1行＋1節を追記するスクリプト
```

---
<br/>
<br/>

## 自己進化
このスキル自身の動作（ルーティング判断・claim の扱い・番号採番など）に問題があった場合は `memory_improvement/README.md` に記録する。PJT 固有のワークフローの問題（例：このPJTでは提案の宛先スキルの粒度が細かすぎる、など）は PJT ガイドラインへ記録し、ここには書かない。
