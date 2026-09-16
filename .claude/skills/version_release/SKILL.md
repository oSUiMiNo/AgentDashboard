---
name: version_release
description: このPJT（AgentDashboard）の版を上げて配り、実機ツリーへ反映するときに使う。「版を上げて」「リリースして」「配って」のような依頼、または periodic の6時間毎の巡回（`--tick`）から使う。段1〜5の一連（差分確認・版決め・門4つ・配布・実機反映）を1体で持ち、赤が出たら配らずに理由を残して止まる。
argument-hint: "[--now | --tick | --stop | --restart]"
---

# version_release

このPJT専用の・版上げ配布 スキル。前回タグから今日までの差分を確認し、門4つ（テスト・タグ整合・実機ビルド・サニタイズ）を通ったときだけ配り、実機ツリーへ反映する。実行の本体は `mainflow.md` に書いてある。呼ぶときはまずそちらを読むこと。

---
<br/>
<br/>

## 使い方

引数なしで呼ぶと、periodic の状態を見て「いま定期実行のタイミングか」を判断する（`mainflow.md` 入口①）。人が明示的に版上げを頼むときは `--now`、periodic の cron から起こされたときは `--tick`、定期実行を止めたいときは `--stop`、実機への反映だけをやり直したいときは `--restart` を渡す。

## 自己進化

このスキル自身の動作・ルーティング・プロトコル・ツール選択に問題があったときは `memory_improvement/README.md` へ追記する。PJT固有のワークフローが原因のときは PJT ガイドライン（`.claude/docs/guideline.md`）側へ書く。判断の問いは「この改善は、このスキルが全く別のプロジェクトで使われても同様に必要か」。

## ディレクトリ構成

```
version_release/
├── SKILL.md
├── mainflow.md
├── memory_improvement/
│   └── README.md
├── knowledge/
│   └── gates.md
└── bin/
    ├── since-tag
    ├── bump
    ├── ship
    ├── build-live
    └── state-doc-update
```
