# version_release の進め方

前回タグからの差分を確認し、門4つ（テスト・タグ整合・サニタイズ・実機ビルド）を通ったときだけ配り、実機ツリーへ新しい実行ファイルを用意する。**実機への切り替え（`agentdashboard version restart`）だけは、`--restart` で明示的に頼まれたとき以外に打たない。** 赤が出たら配らずに理由を `_shared/state/version_release.json` へ残して止まる（形は `knowledge/gates.md` を参照）。

---
<br/>
<br/>

## §6-1：入口（5つ）
このスキルを起動した引数で、最初にどこへ入るかを決める。

- **引数なし**：`.claude/skills/_shared/bin/periodic version_release` を実行する。`run-now` なら段1から通しで実行する。`wait <時刻>` ならその時刻を報告して終了する。`unarmed` なら §6-7 の arm 手順だけ行って終了する
- **`--now`**：人が明示的に依頼した。段1から通しで実行する
- **`--tick`**：periodic の cron から起こされた。`.claude/skills/_shared/bin/periodic tick version_release` を実行し、出力が `run` のときだけ段1から実行する。それ以外（半周期に満たない）は何もせず終了する
- **`--stop`**：`.claude/skills/_shared/bin/periodic stop version_release` を実行して定期実行を止めるだけ。人から明示に止めるよう頼まれたときだけ使う
- **`--restart`**：段1〜4を飛ばし、§6-6（実機反映）だけをやり直す。版は `_shared/state/version_release.json` の直近成功分（`version`）を使う。ここでだけ `agentdashboard version restart` を打ってよい

---
<br/>
<br/>

## §6-2：段1（差分確認と門1＝テスト）
**誰がやるか**：メイン

`bin/since-tag --json` で前回タグから今日までの差分を見る。コミットが0件なら「配るものが無い」と報告して正常終了する（門は通さない）。

差分があれば門1（テスト）を通す。ワーカを出して `make ci`（lint → test → build）を回させる。

```
subagent_type: "general-purpose"
model: "sonnet"
```

緑ならメインは段2へ進む。赤なら `knowledge/gates.md` の形で `_shared/state/version_release.json` に `phase: 1`・`version`（未定なら空）・`red`（失敗したテスト名や `make ci` の要約）を書いて止まる。

**止まる条件**：門1が赤

---
<br/>
<br/>

## §6-3：段2（版を決めて上げる）
**誰がやるか**：メイン（`claim` で `__版上げ__` を取る）

`.claude/skills/_shared/bin/claim <自分の識別子> take __版上げ__ "version_release 版上げ"` を実行してから `bin/bump --dry-run` で変更点（`server/Cargo.toml`・`server/Cargo.lock`・`docker/compose.yml`・`CHANGELOG.md` の4ファイル）を確認し、問題なければ `bin/bump --version <版>` を実行する。終わったら必ず `free` する。

門2（タグ整合）：`bin/bump` 後の版番号が4ファイルすべてで一致しているか（特に `CHANGELOG.md` の `## <版>` 見出しと `Cargo.toml` の `version =`）を確認する。ずれていれば `phase: 2`・`version`・`red` を状態ファイルへ書いて止まる。

**止まる条件**：`claim` の終了コードが3（他セッションが `__版上げ__` を握っている）。門2が赤

---
<br/>
<br/>

## §6-4：段3（配る＝コミット・push・タグ、門3＝サニタイズ）
**誰がやるか**：ワーカ

```
subagent_type: "general-purpose"
model: "sonnet"
```

門3（サニタイズ）：`scripts/sanitize-fixtures.py` を対象ディレクトリに対して回し、「機微情報の残存なし」を確認する。赤ならコミットせずに `phase: 3`・`version`・`red` を状態ファイルへ書いて止まる。

緑なら段2の変更をコミットし、**`main` とタグの両方を push** する（タグを push すると `release.yml` から `dist` が呼ばれてリリース本体が作られる。**人が手で `gh release create` を叩かない**）。押し終えたら `bin/ship --dry-run --version <版>` で確認してから `bin/ship --version <版>` を実行する。

**止まる条件**：門3が赤

---
<br/>
<br/>

## §6-5：段4（実機ツリーで建てる、門4＝実機ビルド）
**誰がやるか**：ワーカ

```
subagent_type: "general-purpose"
model: "sonnet"
```

`bin/build-live` を実行する（claim の取得・解放は `build-live` 自身が `__重いテスト__` に対して行う）。**実機ツリー（`~/AgentDashboard`）でだけ建てる。開発ツリーで `make build` しても実機は変わらない。**

門4（実機ビルド）：ビルド後の実行ファイルの版が段2で上げた版と一致しているかを確認する。失敗またはずれていれば `phase: 4`・`version`・`red` を状態ファイルへ書いて止まる。

**止まる条件**：`claim` の終了コードが3（他セッションが `__重いテスト__` を握っている）。門4が赤

---
<br/>
<br/>

## §6-6：段5（状態docを直し、実機反映の直前で止まる）
**誰がやるか**：メイン

`bin/state-doc-update` で `.claude/docs/knowledge/いま動いているもの.html` を実測値（走行版・PID・起動時刻・ディスクの版・予約の有無）で直す。アンカーが1箇所に定まらない欄があれば「手で直す：<アンカー>」として報告に含める（この欄以外は止めない）。

**ここで通しの実行を終える。** `--restart` で明示的に頼まれた場合だけ続けて `agentdashboard version restart` を打つ。それ以外の入口（引数なし／`--now`／`--tick`）では、**段5の最後に次の2つを書いて止まる**：

- 生きたカードの数（`ps -eo pid,ppid,args --forest` などで実機ツリーの子を数える）
- そのまま貼れる `agentdashboard version restart`（強行が要る場合は `--force` 付きも添える）

**止まる条件**：常に、実機反映の直前で（`--restart` のとき以外）

---
<br/>
<br/>

## §6-7：段6（periodic の後始末）
**誰がやるか**：メイン

通しの実行（引数なし／`--now`／`--tick`）が終わったら、`.claude/skills/_shared/bin/periodic arm version_release` を実行して次回の実行時刻を予約する（他スキルの実行時刻と15分以上離す、`:00`／`:30` は避ける、という `periodic` 自身の既定に従う）。

`arm` が出す cron 式で、`CronCreate` を `recurring:false` で1本作る。プロンプトは `/version_release --tick` を渡す。次回もこの段6で次々回ぶんを arm し直すので、常駐のスケジューラではなく都度1本の使い捨て cron で回す。

**止まる条件**：無し（後始末なので失敗しても通しの結果自体は報告済み）
