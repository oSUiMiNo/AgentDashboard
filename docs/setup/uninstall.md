# 消す

入れたものを取り除く手順。**記録（一覧・履歴）は既定では消しません。**

---
<br/>
<br/>

## 消す
Linux / macOS：

```
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-uninstaller.sh | sh
```

Windows（PowerShell）：

```
irm https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-uninstaller.ps1 | iex
```

先に何が起きるか見たいなら、`--dry-run` を付ける。**何も消さずに、消す対象だけ並べる。**

```
curl -LsSf https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-uninstaller.sh | sh -s -- --dry-run
```

パイプで引数を渡すときに `sh -s --` を挟むのは、シェルの決まり。

---
<br/>
<br/>

## 何が消えて、何が残るか
| もの | どこ | 既定 |
|---|---|---|
| 実行ファイル3本 | `~/.local/bin/`（入れた場所は控えから読む） | **消える** |
| インストールの控え | `~/.config/agentdashboard/` | **消える** |
| 記録（一覧・履歴・アカウント） | `~/.local/state/agentdashboard/` | **残る** |
| PATH の通し方 | `~/.local/bin/env` とシェルの設定の1行 | **残る** |

### 記録を残すのは、戻せないから
消えるのは**セッションの一覧・やりとりの履歴・アカウントとペアリングの記録**。入れ直しても戻りません。

消してよいと決めたら `--purge` を付けます。

```
curl -LsSf https://…/agentdashboard-uninstaller.sh | sh -s -- --purge
```

Windows は `-Purge`（いったん落としてから実行する）。

```
irm https://…/agentdashboard-uninstaller.ps1 -OutFile uninstall.ps1
.\uninstall.ps1 -Purge
```

### PATH に触らないのは、他のツールと共有だから
`~/.local/bin` は、同じ仕組み（cargo-dist）で配られたツールが**みんなで使う場所**です。`~/.local/bin/env` と、シェルの設定に足された1行もそこに属します。ここを消すと**関係のないツールの PATH まで壊れます**。

他に使っているものが無いと分かっているなら、自分で消してください。

```
rm ~/.local/bin/env ~/.local/bin/env.fish
```

そのうえで、`~/.profile` `~/.bashrc` `~/.zshrc` などから次の行を消します。

```
. "$HOME/.local/bin/env"
```

---
<br/>
<br/>

## 場所によって残るものが違う
どの使い方をしていたかで、手で片付けるものが変わります。

| 使い方 | 消したあとに残りうるもの |
|---|---|
| [ローカル](local.md) | 記録（`--purge` で消える） |
| [セルフホストのサーバー・道①](selfhost.md) | 記録。常駐させたなら **systemd の設定**（下記） |
| [セルフホストのサーバー・道②](selfhost.md) | **記録は Docker の中**（下記） |
| [PC 側エージェント](pairing.md) | 自分で置いた `agent.toml` |

### 常駐させた場合（道①）
```
sudo systemctl disable --now agentdashboard
sudo rm /etc/systemd/system/agentdashboard.service
sudo systemctl daemon-reload
```

### compose で立てた場合（道②）
アンインストーラは**コンテナには触りません**。献立表のあるディレクトリで畳みます。

```
docker compose down            # 記録は残る
docker compose down --volumes  # 記録も消える（戻せません）
```

### PC 側で残るもの
サーバーへ繋ぐために書いた `agent.toml` は、置いた場所が人によって違うので**自動では消しません**。自分で消してください。

サーバー側に残っている**その PC の登録**は、ダッシュボードのアカウント画面から失効させます。

---
<br/>
<br/>

## 触らないもの
利用者の **`~/.claude/settings.json` には手を出しません**（消すときも、使っている間も）。

ダッシュボードがセッションへ入れるフックや statusLine は、**そのセッション専用の設定ファイル**として渡しています。グローバル設定には書き込んでいないので、消したあとに掃除するものはありません。

---
<br/>
<br/>

## うまくいかないとき
| 症状 | 見るところ |
|---|---|
| 「見つかりませんでした」と出る | 既に消えているか、控えが指す場所と実際の場所が違う。`--dry-run` でどこを見ているか確かめる |
| 消せませんでした、と出る | 書き込む権限があるか。Windows では**その実行ファイルが動いていないか** |
| 消したのに `agentdashboard` が動く | シェルが古い場所を覚えている。開き直すか `hash -r` |
| 記録だけ消したい | アンインストーラは使わず、`~/.local/state/agentdashboard/` を消す |
