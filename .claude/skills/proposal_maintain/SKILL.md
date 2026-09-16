---
name: proposal_maintain
description: 各スキルとPJT横断の PROPOSAL.md を6時間ごとに整備する。段1でワーカが全行を集め、段2でメインが削除・統合・修正・見送りを決め、段3でワーカが機械的に反映し、段4で見取り図の機械的な差分だけを直す。periodic の巡回（`--tick`）から起こされるほか、「PROPOSAL.md を整理して」「たまった提案を片付けて」のような依頼でも使う。
argument-hint: "[--now | --tick | --stop]"
---

# proposal_maintain

`PROPOSAL.md`（PJT横断・各スキル）を定期的に整備する・スキル。`proposal_submit` が書き溜めた提案を読み、古くなった行・重複した行を削除・統合・修正・見送りに仕分け、見取り図との食い違いも直す。実行の本体は `mainflow.md` に書いてある。呼ぶときはまずそちらを読むこと。

---
<br/>
<br/>

## 何をするスキルか
`proposal_submit` は書くだけで、読み直しも片付けもしない。放っておくと `PROPOSAL.md` は増える一方になり、どの行がまだ生きているか誰にも分からなくなる。このスキルは6時間ごとに巡回し、たまった提案を読み直して仕分ける。

やることは4段。

| 段 | 誰が | 何を |
|---|---|---|
| 段1：拾い出し | ワーカ | `bin/list-proposals` で全 `PROPOSAL.md` の全行を集め、要約・重複候補・経過日数を返す |
| 段2：決める | メイン | 行ごとに削除・統合・修正・見送りを決める |
| 段3：反映 | ワーカ | `bin/apply-decisions <決定JSON>` で機械的に直し、変更ログへ1行 |
| 段4：見取り図の整合 | ワーカ | `bin/map-check --fix` で見取り図の機械的に決まる差分だけを直す |

**段2で各スキルの `mainflow.md` 自体は直さない。** スキル本体の動作を直すのは、そのスキルが自分の起動時に行う自己進化の仕事であって、このスキルの領分は `PROPOSAL.md` の記録と見取り図の整合に限られる。

---
<br/>
<br/>

## 手順
詳しい手順は `mainflow.md` を見よ。ここでは全体像だけを示す。

1. 入口：引数なしなら `periodic status` で巡回タイミングを見る。過ぎていれば本処理、そうでなければ `arm` だけして終わる
2. 読むべき `PROPOSAL.md` が1つも無ければ、本処理をせず `arm` だけして終わる
3. 段1〜段4を通しで実行する
4. 終わったら `periodic arm proposal_maintain` で次回を予約し、`CronCreate`（`recurring:false`）を1本打つ

---
<br/>
<br/>

## ディレクトリ構成
```
proposal_maintain/
├── SKILL.md                このファイル
├── mainflow.md              入口・段1〜段4・後始末の詳細手順
├── memory_improvement/
│   └── README.md           自己進化の記録先（このスキル自身の動作・ルーティングの問題を書く）
└── bin/
    ├── list-proposals       PROPOSAL.md を集めて一覧化する（読むだけ）
    ├── apply-decisions      decisions JSON を PROPOSAL.md へ機械的に反映する
    └── map-check            見取り図と実フォルダを突き合わせ、--fix で機械的な差分だけ直す
```

---
<br/>
<br/>

## 自己進化
このスキル自身の動作（ルーティング判断・仕分けの物差し・periodic の扱いなど）に問題があった場合は `memory_improvement/README.md` に記録する。PJT 固有のワークフローの問題（例：このPJTでは提案の宛先スキルの粒度が細かすぎる、など）は PJT ガイドラインへ記録し、ここには書かない。
