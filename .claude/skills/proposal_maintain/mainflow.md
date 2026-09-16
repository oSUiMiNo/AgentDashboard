# proposal_maintain の進め方

`PROPOSAL.md`（PJT横断・各スキル）を6時間ごとに読み直し、削除・統合・修正・見送りへ仕分けたうえで、見取り図との食い違いも直す。入口の判定→段1〜段4→後始末の順で進める。

---
<br/>
<br/>

## 入口（4通り）
- **引数なし**：`.claude/skills/_shared/bin/periodic status proposal_maintain` を実行する。`run-now` なら段1から通しで実行する。`wait <時刻>` ならその時刻を報告して終了する。`unarmed` なら後始末（下の「後始末」節）だけ行って終了する
- **`--now`**：人が明示的に依頼した。段1から通しで実行する
- **`--tick`**：periodic の cron から起こされた。`.claude/skills/_shared/bin/periodic tick proposal_maintain` を実行し、出力が `run` のときだけ段1から実行する。`skip`（前回から半周期に満たない）のときは何もせず終了する
- **`--stop`**：`.claude/skills/_shared/bin/periodic stop proposal_maintain` を実行してから、生きている cron を `CronDelete` で消す。**利用者が明示的に止めるよう指示したときだけ**使う。他の入口からこの動作を行ってはならない

---
<br/>
<br/>

## 止まる条件（本処理に入る前）
`bin/list-proposals --json` を実行し、収集できた行が0件（＝読むべき `PROPOSAL.md` が1つも無い）だった場合は、段1〜段4を行わず、下の「後始末」だけ行って終わる。
`bin/map-check` の終了コードは 0＝差分なし、1＝差分あり、2＝実行時エラー。

---
<br/>
<br/>

## 段1：拾い出し
**誰がやるか**：ワーカ

```
subagent_type: "general-purpose"
model: "sonnet"
```

`bin/list-proposals --json` を実行させ、全 `PROPOSAL.md`（`.claude/skills/PROPOSAL.md` と `.claude/skills/*/PROPOSAL.md`）の全行を集めさせる。ワーカには行ごとに次の3点を整理して返させる。

- 要約（提案が何を言っているかを短く言い直したもの）
- 重複候補（同じ改善の種を指していそうな行同士の組。宛先ファイルをまたいでもよい）
- 経過日数（`list-proposals` が出す値をそのまま使う）

**worker側が守ること**
- `bin/list-proposals` が返した行を書き換えない。要約・重複候補・経過日数を添えて返すだけ
- どのファイルも書き換えない（`list-proposals` 自体が読み取り専用）

---
<br/>
<br/>

## 段2：決める
**誰がやるか**：メイン（委譲しない）

段1の結果を1行ずつ見て、「削除・統合・修正・見送り」のどれにするかを決める。判断の物差しは次の4つ。

- 手順（procedure／method）が既に決まっているか
- 飛ばすと静かに壊れる（誰にも気づかれず不整合が残る）ものか
- 既にある仕組みと重ならないか
- 次の判断に使える情報を持っているか

この4つに加えて、行ごとに必ず「3か月後も要るか」を問う。要らないと判断できる行は削除、他の行と同じ種を指しているなら統合、内容が古くなっているだけなら修正、まだ判断材料が揃っていないなら見送りにする。

決めた内容は、`bin/apply-decisions` が読める decisions JSON（`{"file", "no", "action", ...}` の配列）の形にまとめる。`action` は `merge`／`close`／`edit` のいずれか（`apply-decisions` 自身の語彙に合わせる。見送りは decisions に含めない＝何もしない）。

**この段で `proposal_maintain` がスキル本体（各スキルの `mainflow.md` そのもの）を直すことはしない。** 提案の中に「このスキルの動作をこう変えるべきだ」という内容があっても、ここでは行うべき対応を決めるところまでで止め、各スキルの `mainflow.md` の書き換えはそのスキル自身が自分の起動時に行う自己進化に委ねる。

---
<br/>
<br/>

## 段3：反映
**誰がやるか**：ワーカ

```
subagent_type: "general-purpose"
model: "sonnet"
```

段2で作った decisions JSON をワーカへ渡し、`bin/apply-decisions <決定JSON>` を実行させる。`apply-decisions` は行を絶対に削除せず、`merge`／`close` は完了ステータスを `[x]` にして特記事項へ理由を足すだけ、`edit` は提案本文を差し替えるだけで、要約文を新しく書き起こすことはしない（渡した `text`／`note` の文字列がそのまま転記される）。対象ファイル1つにつき、変更ログへ新規行がちょうど1行だけ追記される。

**worker側が守ること**
- decisions JSON の中身（`text`／`note` の文言）をワーカが独自に書き換えない。メインが決めた文言をそのまま渡す
- `apply-decisions` の実行結果（どのファイルへ何行足したか）を報告させる

---
<br/>
<br/>

## 段4：見取り図の整合
**誰がやるか**：ワーカ

```
subagent_type: "general-purpose"
model: "sonnet"
```

`bin/map-check --fix` を実行させ、見取り図（`_イシューの見取り図.json`／`.html`）の**機械的に決まる差分だけ**を直させる（実フォルダの列挙は既定で `--issues-dir` が指す `MyDocs/イシュー` を基準にする）。

**worker側が守ること**
- 要約文を新しく書かせない。`map-check --fix` が機械的に埋められる項目（行の有無・件数など）だけを直させる
- HTML を直接編集させない。HTML は JSON から作り直されるものなので、直すのは常に JSON 側

---
<br/>
<br/>

## 後始末（periodic の再武装）
通しの実行（引数なし／`--now`／`--tick`）が終わったら、`.claude/skills/_shared/bin/periodic arm proposal_maintain` を実行して次回の実行時刻を予約する（他スキルの実行時刻と15分以上離す、`:00`／`:30` を避ける、という `periodic` 自身の既定に従う）。

`arm` が出す cron 式で、`CronCreate` を `recurring:false` で1本作る。プロンプトは `/proposal_maintain --tick` を渡す。次回もこの段で次々回ぶんを arm し直すので、常駐のスケジューラではなく都度1本の使い捨て cron で回す。

**止まる条件**：無し（後始末なので失敗しても通しの結果自体は報告済み）
