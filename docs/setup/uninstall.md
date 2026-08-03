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
| fish の設定（fish を使っている場合） | `~/.config/fish/conf.d/agentdashboard.env.fish` | **消える** |
| 記録（一覧・履歴・アカウント） | **実行ファイルに聞いた場所**（既定は `~/.local/state/agentdashboard/`） | **残る** |
| PATH の通し方 | `~/.local/bin/env` とシェルの設定の1行 | **残る** |

### 記録の場所は、こちらで決めない
消す側は `agentdashboard state-dir` を叩いて、**そのインストールが実際に使っている場所**を聞きます。設定（`config.toml` の `state_dir`）や環境変数で変えていても、そこが対象になります。

自分で組み立てていたときは既定しか見ておらず、**変えた人の記録は「完了しました」と言いながら残っていました**。

実行ファイルが既に無いなど、聞けないときは既定へ落ちます。そのときは**聞けなかったことを表示**するので、置き場所を変えていた人はそこで気づけます。

### 古い版が一時領域へ置いた記録も掃きます
`v0.1.0` には Windows 向けの分岐が無く、記録が一時領域（`%LOCALAPPDATA%\Temp\agentdashboard\`）へ置かれていました。**いまの実行ファイルはそこを知らない**ので、聞いても返ってきません。

放っておくと誰も消せない記録になるので、`--purge`（Windows は `-Purge`）のときはそちらも掃きます。付けないときは、見つかったことだけ表示します。

**古い記録の引っ越しはしません。** 新しい場所は空のまま始まるので、`v0.1.0` を Windows で使っていて履歴を引き継ぎたい場合は、手でコピーしてください。

### fish のファイルだけ消すのは、アプリ専用だから
他のシェルは既存の設定ファイルへ1行足すだけですが、**fish にだけはファイルごと新規に作ります**。名前がアプリ名そのもので他のツールと共有していないので、入れる側が作ったものは消す側も消します。

残すと、下の案内どおりに `env.fish` を消した fish 利用者は、**シェルを開くたびにエラーを見ることになります**（消えたファイルを読み続けるため）。

### 記録を残すのは、戻せないから
消えるのは**セッションの一覧・やりとりの履歴・アカウントとペアリングの記録**。入れ直しても戻りません。

消してよいと決めたら `--purge` を付けます。

```
curl -LsSf https://…/agentdashboard-uninstaller.sh | sh -s -- --purge
```

Windows は `-Purge`（いったん落としてから実行する）。**Windows の記録は `%LOCALAPPDATA%\agentdashboard\` に置かれます**（`HOME` が無いため、Unix とは場所が違います）。

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

そのうえで、次の行を消します。

```
. "$HOME/.local/bin/env"
```

書き込まれている可能性があるのは、**次のうち存在するもの全部**です。`~/.profile` だけを見て終わりにすると、`~/.bash_profile` を使っている場合などに行が残り、**シェルを開くたびにエラーが出ます**。

| シェル | ファイル |
|---|---|
| sh / bash | `~/.profile` ／ `~/.bashrc` ／ `~/.bash_profile` ／ `~/.bash_login` |
| zsh | `~/.zshrc` ／ `~/.zshenv` |

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
**消すときは、利用者の `~/.claude/settings.json` に手を出しません。**

ダッシュボードがセッションへ入れるフックや statusLine は、**そのセッション専用の設定ファイル**として渡しています。ここは消したあとに掃除するものがありません。

### ただし、使っている間は `model` の値だけ触ります
セッション画面からモデルを切り替えると、`claude` 自身がグローバル設定の `model` を書き換えます。ダッシュボードは**切り替える前の値を覚えておいて、セッションが終わるときに戻します**（あなたが自分で変えた値は、新しい既定として覚え直して戻しません）。

戻せないのは次のときです。

| 起きること | 結果 |
|---|---|
| ファイルが読めない・壊れている・権限が無い | **何もしません**（読みにも行きません） |
| 書き戻しに失敗した | 以後は読みにも行かなくなります。**切り替えた値が残ったまま**になりえます |

心当たりがあれば、消したあとに `~/.claude/settings.json` の `model` を見てください。触るのは**このキーだけ**です。

---
<br/>
<br/>

## うまくいかないとき
| 症状 | 見るところ |
|---|---|
| 「見つかりませんでした」と出る | 既に消えているか、控えが指す場所と実際の場所が違う。`--dry-run` でどこを見ているか確かめる |
| 消せませんでした、と出る | 書き込む権限があるか。Windows では**その実行ファイルが動いていないか** |
| 消したのに `agentdashboard` が動く | シェルが古い場所を覚えている。開き直すか `hash -r` |
| 記録だけ消したい | アンインストーラは使わず、`agentdashboard state-dir` で場所を聞いてから、そのフォルダを消す（**OS と設定で場所が違う**ので決め打ちにしない） |
