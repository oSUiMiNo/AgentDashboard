# リバースプロキシ（TLS）

ダッシュボードは **HTTP しか話さない**。証明書の面倒は前段のプロキシに任せる、という分け方にしてある（設計§14-2）。

インターネットからスマホで使うなら TLS は必須。中身はターミナルの入力そのものなので、平文で流すのは実質パスワードを流すのと変わらない。

---
<br/>
<br/>

## 満たすべき条件はひとつだけ
**WebSocket が2本とも通ること。**

| パス | 誰が使うか |
|---|---|
| `/ws` | ブラウザ。一覧の更新と画面の中継 |
| `/agent/ws` | セッションホスト。状態の報告と指示の受け取り |

片方だけ通す設定にすると、**半分だけ動く**——「画面は出るのに PC が繋がらない」「PC は繋がるのに画面が固まる」。原因が見えにくい壊れ方なので、両方まとめて通すのが安全。

---
<br/>
<br/>

## Caddy（おすすめ）
設定は **[`docs/proxy/Caddyfile`](../proxy/Caddyfile)** にある。**この検証で実際に使っているファイルそのもの**なので、貼り付けの写し間違いが起きない。

変えるのは2箇所（ファイル冒頭に書いてある）。ドメインを書くと **証明書を自動で取る**。

```caddyfile
dashboard.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

WebSocket のための追記は要らない。`reverse_proxy` が Upgrade をそのまま通す。

---
<br/>
<br/>

## nginx
設定は **[`docs/proxy/nginx.conf`](../proxy/nginx.conf)** にある。こちらも検証で実際に使っているもの。置き場所は `/etc/nginx/conf.d/agentdashboard.conf`。

nginx は既定で HTTP/1.0 に落として転送するので、**そのままでは Upgrade が通らない**。次の3行が要る。

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

もう1つ、忘れると後で困るのが待ち時間。

```nginx
proxy_read_timeout 1h;
```

ターミナルは**何も起きない時間**が長い。既定の60秒だと、考えている間に接続を切られて画面が止まったように見える。

---
<br/>
<br/>

## アプリ側で1つだけ足す
TLS を前段で終端したら、ダッシュボードへこれを渡す。

```
AGENTDASHBOARD_COOKIE_SECURE=true
```

付けないと、**HTTPS で開いているのに入館証が平文でも送られる**。逆に、平文で動かしている間に付けると**ログインできなくなる**（Secure の Cookie は HTTPS でしか送られない）ので、TLS を用意してから付ける。

---
<br/>
<br/>

## ドメインが無いとき
Tailscale や Cloudflare Tunnel でも同じことができる。どちらも WebSocket をそのまま通すので、この文書で気にすることは `AGENTDASHBOARD_COOKIE_SECURE=true` だけになる。

---
<br/>
<br/>

## 接続元のヘッダは信じていない
`X-Forwarded-For` を渡しても使われない。LAN からの免除（[ローカルで使う](local.md)）を、**誰でも書けるヘッダで取れてしまう**ことを避けるため、接続元は接続そのものから見ている。渡しても害は無いが、効きもしない。

---
<br/>
<br/>

## うまくいかないとき
| 症状 | 見るところ |
|---|---|
| 画面は出るが「切断」のまま | `/ws` が Upgrade を通していない。nginx なら上の3行 |
| 画面は動くが PC が繋がらない | `/agent/ws` が通っていない。パスで分けた設定にしていないか |
| しばらく放置すると画面が止まる | `proxy_read_timeout` が短い |
| ログインした直後に弾かれる | `AGENTDASHBOARD_COOKIE_SECURE` と実際の綴り（`http` / `https`）が食い違っている |
