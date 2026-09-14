# ローカルで使う

自分の PC 1台で完結する使い方。ダッシュボードも Claude Code のセッションも、同じ機械の中で動く。**サーバを用意する必要は無い。**

別の機械のブラウザから使いたい（スマホから見たい・自宅サーバへ集めたい）場合は [セルフホストで使う](selfhost.md) を読む。

---
<br/>
<br/>

## 要るもの
| もの | なぜ |
|---|---|
| 本物の `claude` と認証 | ダッシュボードが起動する対象そのもの |

それだけ。**Docker も Node も要らない**（開発するときだけ要る）。

---
<br/>
<br/>

## 入れる
```
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-installer.sh | sh
```

Windows（PowerShell）：

```
irm https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-installer.ps1 | iex
```

`~/.local/bin` へ3つ入る。

| 実行ファイル | 役 |
|---|---|
| `agentdashboard` | ここで使うのはこれ |
| `agentdashboard-agent` | サーバへ繋ぐときに使う（[セルフホスト](selfhost.md)） |
| `transcript-parser` | 履歴を読む相棒。**隣に居ることが条件**なので、動かさないこと |

---
<br/>
<br/>

## 動かす
```
agentdashboard
```

ブラウザで **http://127.0.0.1:8787** を開く。一覧の「**PJT を追加**」でフォルダを選ぶか**作業ディレクトリのパス**を打ち込み、できた枠の「**＋**」を押せば始まる。

待ち受けは `127.0.0.1` だけなので、**同じ機械からしか開けない**。同じ家の別の端末から開きたいときは次へ。

---
<br/>
<br/>

## 同じネットワークの別の端末から開く
順番がある。**先に合言葉を決めてから、待ち受けを広げる。**

1. `127.0.0.1:8787` で起動したまま、ブラウザで **設定画面（`/settings`）** を開き、「LAN パスワード」を登録する
2. いったん止めて、`config.toml` に1行書く

```toml
bind_addr = "0.0.0.0"
```

3. もう一度起動する

順番を逆にすると**起動を断られる**。合言葉の無いまま待ち受けを広げると、同じネットワークに居る誰でも操作できてしまうので、そうならない側に倒してある。

合言葉は**ファイルに書かない**（設定画面から登録し、ダッシュボードは元の文字列を持たない）。`127.0.0.1` から開いたときは聞かれない——自分の機械なので。一度入れば5時間有効で、切れたら入れ直す。

### 別の端末から開くアドレスは、押すだけで手に入る
広げたあと、**どの番号で開けばよいか**は画面が教える。上部の帯にあるボタンを押すと、そのまま貼れる形（`http://<番号>:8787/`）でクリップボードへ入る。スマホへ送るなら、あとは自分宛のチャットにでも貼ればよい。

**自分で番号を調べようとしないこと。** とくに WSL で動かしている場合、`hostname -I` や `ip addr` が返す番号は**外から届かない**——あれは Windows からの横流しの受け先で、同じネットワークの別の端末からは繋がらない。`192.168.` で始まるので本物に見えるのが厄介なところで、ボタンはこれを除いた番号だけを出す。

候補が複数あるときは選べる。1つも無いときは、その理由が出る。

CLI からも同じものが取れる。

```
agentdashboard address          # そのまま貼れる1行
agentdashboard address --json   # 候補ぜんぶと、待ち受けが広がっているか
```

待ち受けを広げていないときは、ボタンの代わりに**広げ方の案内**が出る（押しても死んだアドレスしか渡らないボタンは置いていない）。

設定できる項目は `server/config.toml.example` が全キーの一覧を兼ねている。解決後の値は `agentdashboard config` で確認できる。

---
<br/>
<br/>

## WSL で常駐させる
**これは WSL で動かしているときだけの話。** Linux や macOS で直に動かしているなら、普通の systemd の設定でよい。

WSL は既定で systemd を使わないので、**そのままでは「落ちたら誰も起こさない」機械**になる。次で縮小（下の節）を自動化するなら、先にここを済ませておくこと——**縮小は WSL ごと落とすので、起こす係が居ないと戻ってこない。**

**【要人間】が2つある。** どちらも `sudo` か、走っている作業を落とす操作である。

### 1. WSL で systemd を有効にする
`/etc/wsl.conf` に2行足す。

```toml
[boot]
systemd=true
```

**書いただけでは効かない。** WSL を再起動して初めて効き、**その再起動は走っている claude を全部落とす**。「足した」を「効いている」と数えないこと——確かめ方は `systemctl is-system-running` が `offline` 以外を返すかどうかである。

### 2. 常駐の雛形を置いて有効にする
雛形は `docs/service/agentdashboard-local.service` にある。**書き換えるのは利用者名だけ**（`User=` と、`WorkingDirectory=` / `ExecStart=` のパス）。

```
sudo cp docs/service/agentdashboard-local.service /etc/systemd/system/
sudo systemctl enable --now agentdashboard-local
```

**実機ツリーを指すこと。** 開発ツリーで `make build` しても、実機の画面は変わらない。

---
<br/>
<br/>

## 使ったぶんを Windows へ返す（WSL）
**WSL の中でファイルを消しても、Windows から見た空きは戻らない。** 仮想ディスクは一度膨らむと縮まず、`fstrim` を打っても1バイトも返らない（2026-09-14 実測）。**返す道は「WSL を止めて、仮想ディスクを縮める」だけ**である。

止めるということは、**走っている claude が全部落ちる**ということである。だから機械が勝手に打つのは「静かなとき」だけで、**既定では自動は切ってある**。

### 【要人間】はタスクの登録1回だけ
縮小には管理者権限が要る。毎回 UAC を押すのでは自動にならないので、**「最上位の特権で実行」のタスクを一度だけ登録する**。以後はダッシュボードがそれを起動するだけなので、UAC は出ない。

台本は `docs/service/compact-wsl.ps1` にある。**管理者の PowerShell で1回だけ**次を流す。

```powershell
$script = "C:\path\to\AgentDashboard\docs\service\compact-wsl.ps1"
$arg = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
# 実行時間の上限を外す。既定のままだと、圧縮の途中で殺されうる
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
# -User は自分のアカウント。SYSTEM で登録すると「別の WSL」を起こしてしまう
Register-ScheduledTask -TaskName "AgentDashboard Compact WSL" -Action $action -Settings $settings -RunLevel Highest -User $env:USERNAME
```

**実行時間の上限を外す行が、ここでいちばん大事である。** 圧縮には10〜15分まったく無反応な時間があり、既定の上限を残すと**その途中で殺される**——縮小の失敗としては唯一、実害のある形になる。

**`-User` を自分のアカウントにすること。** WSL は Windows の利用者ごとに別の仮想マシンなので、SYSTEM で登録すると誰も使っていない WSL を起こして終わる。

### 押す
| やりたいこと | 打つもの |
|---|---|
| いま縮める | 設定画面の「いま縮める」、または `agentdashboard host compact run` |
| 打てるかどうかを見る | `agentdashboard host compact status` |
| しばらく打たせない | `agentdashboard host compact pause --until <時刻>` |

**生きたセッションが1つでもあれば、数を言って止まる。** それでも打つなら `--force` を付ける。

自動で打たせるかどうか、しきい値、打ってよい時間帯は設定で決める。全キーの一覧は `server/config.toml.example` が兼ねている。

---
<br/>
<br/>

## うまくいかないとき
| 症状 | 見るところ |
|---|---|
| `agentdashboard: command not found` | `~/.local/bin` が PATH に入っているか。入れ直すか、シェルを開き直す |
| 履歴（構造化ビュー）だけが出ない | `transcript-parser` が `agentdashboard` の隣に居るか。片方だけ移すと見つからない |
| 「パーサの更新が必要です」と出る | Claude Code の書き出す形式が変わった。新しい版を入れ直す（配布版では自分で直せない） |
| モデルが「不明」のまま | `inject_status_line` を切っていないか。モデル名を知る経路はこれだけ |
| コンテキスト残量・使用上限・費用が出ない | 同じ `inject_status_line` を切っていないか。**4つとも同じ payload で届く**ので、切ると全部出ない |
| 「コピー」を押しても入らない | 素の HTTP で LAN の IP を開くと、**ブラウザにクリップボードへ書く口がそもそも無い**（安全なオリジンではないため）。**押せば入る**ようにしてあるが、それも塞がれている環境では**値が選べる形で画面に出る**ので、そこから取る |

---
<br/>
<br/>

## 消したくなったら
[消す](uninstall.md) へ。**記録（一覧・履歴）は既定では消しません。**
