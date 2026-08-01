# PC を繋ぐ（ペアリング）

セルフホストのサーバへ、自分の PC を登録する手順。[セルフホストで使う](selfhost.md) の続き。

繋ぐのは**常に PC 側から**。サーバから PC へ繋ぎに行くことはない——利用者の PC はたいてい NAT の内側に居て、外から届く経路が無いため。ポートを開ける必要も無い。

---
<br/>
<br/>

## 1. トークンを発行する（サーバ側・〜30秒）
ブラウザで **アカウント画面（`/account`）** を開き、札（どの PC 用かの覚え書き）を入れて発行する。

**表示は一度きり。** 控え損ねたら発行し直す（DB にはハッシュしか置いていないので、こちらからも読めない）。

コマンドでも発行できる。画面をまだ作れない状況（最初の1台）ではこちら：

```
docker compose exec dashboard agentdashboard pair-token --account <アカウント名> --label 仕事用ノート
```

---
<br/>
<br/>

## 2. エージェントを入れる（PC 側・〜1分）
[ローカルで使う](local.md) と同じワンライナーで入る。**両方の実行ファイルが入る**ので、既に入れてあるならこの手順は要らない。

```
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-installer.sh | sh
```

---
<br/>
<br/>

## 3. 繋ぎ先とトークンを渡して起動する（〜30秒）
`agent.toml` を置いて2行書く。雛形は `server/agent.toml.example`。

```toml
server_url = "https://dash.example.com"
pairing_token = "adp_…"
```

```
agentdashboard-agent
```

環境変数でも渡せる（サービスとして常駐させるならこちらが楽）。

```
AGENTDASHBOARD_SERVER_URL=https://dash.example.com \
AGENTDASHBOARD_PAIRING_TOKEN=adp_… \
  agentdashboard-agent
```

ダッシュボードの一覧に PC が現れたら完了。

---
<br/>
<br/>

## 覚えておくとよいこと

### PC の名前を変えると別の PC になる
既定はホスト名。`agent_name` で変えられるが、**アカウントの中ではこの名前が PC の同一性**になっている。変えると新しい PC として登録され、それまでのカードの帰属が切れる。

### トークンは何本でも発行できる
PC ごとに1本にしておくと、失くしたときにその1台だけを止められる。失効はアカウント画面から。**失効させると、繋がっている接続もその場で切れる。**

### `https://` なら自動で `wss://`
繋ぎ方は `server_url` の綴りで決まる。前段に TLS を置いたなら `https://` と書く。

### フォルダごとに繋ぎ先を分けられる
作業ディレクトリに `.agent-dashboard.toml` を置くと、そのフォルダで起こしたセッションだけを別のアカウントへ載せられる。**読むのはセッションを起こす瞬間だけ**なので、走っている途中で書き換えても効かない。

---
<br/>
<br/>

## うまくいかないとき
| 症状 | 見るところ |
|---|---|
| `server_url と pairing_token が要ります` と言って終わる | 2つとも渡っているか。`agent.toml` は**起動したディレクトリ**から読む |
| 繋がらない・すぐ切れる | トークンが失効していないか（アカウント画面で確認）。前段のプロキシが `/agent/ws` を通しているか（[リバースプロキシ](reverse-proxy.md)） |
| 一覧に出るが「接続なし」の印が付く | エージェントが落ちている。起こし直すと繋がるが、**落ちる前のセッションは戻らない**（PTY は道連れで死んでいる） |
| セッションは起こせるが履歴が出ない | `transcript-parser` が `agentdashboard-agent` の隣に居るか |
