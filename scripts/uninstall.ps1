# AgentDashboard を消す（Windows / PowerShell）。
#
# 判断の中身は `scripts/uninstall.sh` と同じ。**あちらが本体で、こちらは同じ約束を
# Windows で実行できる形に置き換えたもの**なので、片方を直したら両方を直すこと
# （`crates/dist/tests/uninstall.rs` が、同じ場所を名指ししているかを見張る）。
#
# # 何を消して、何を残すか
#
# | もの | 既定 | なぜ |
# |---|---|---|
# | 実行ファイル3本 | 消す | これが本体 |
# | インストールの控え（receipt） | 消す | 入れた記録なので、消したら要らない |
# | 記録・状態（DB・読み込み位置） | **残す** | **戻せない**。消すなら `-Purge` を明示する |
# | PATH への追加 | **触らない** | 同じ仕組みで入れた**他のツールと共有**している |
#
# # 使い方
#
#   irm https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-uninstaller.ps1 | iex
#
# 引数を渡すときは、いったん落としてから実行する：
#
#   irm https://…/agentdashboard-uninstaller.ps1 -OutFile uninstall.ps1
#   .\uninstall.ps1 -Purge

[CmdletBinding()]
param(
    # 記録（一覧・履歴）も消す。既定では残す
    [switch]$Purge,
    # 消さずに、消す対象だけ並べる
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$AppName = 'agentdashboard'
# 配る実行ファイル。**増減させたら uninstall.sh も一緒に直す**
$Binaries = @('agentdashboard.exe', 'agentdashboard-agent.exe', 'transcript-parser.exe')

# 既定の置き場所。`dist-workspace.toml` の `install-path` と揃える
$DefaultInstallDir = Join-Path $HOME '.local\bin'
$ReceiptDir = if ($env:XDG_CONFIG_HOME) {
    Join-Path $env:XDG_CONFIG_HOME $AppName
} elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA $AppName
} else {
    Join-Path $HOME ".config\$AppName"
}
$Receipt = Join-Path $ReceiptDir "$AppName-receipt.json"

# 記録の置き場所の**控え**。実行ファイルが見つからないときだけ使う。
#
# **本来は実行ファイルへ聞く**（`agentdashboard state-dir`）。こちらで組み立てると、
# 実装の既定を変えたときに黙って食い違う。実際に食い違っていた——**Windows には
# `HOME` が無い**ので、実装は一時領域（`%LOCALAPPDATA%\Temp\`）を使っていたのに、
# こちらは `$HOME\.local\state` を消しに行っていた。`-Purge` が1バイトも消さない状態。
#
# 実装側に Windows 分岐（`LOCALAPPDATA`）を足したので、控えもそちらへ揃える。
# **見るのは `$env:HOME`（環境変数）で、PowerShell の `$HOME` ではない。**
# あちらは常に定義されているので、実装（環境変数を読む）と食い違う。
# 順番も実装と揃える：XDG_STATE_HOME → HOME → LOCALAPPDATA
$StateDirFallback = if ($env:XDG_STATE_HOME) {
    Join-Path $env:XDG_STATE_HOME $AppName
} elseif ($env:HOME) {
    Join-Path $env:HOME ".local\state\$AppName"
} elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA $AppName
} else {
    Join-Path $HOME ".local\state\$AppName"
}

# 版の保管庫と、それに付く小物（記録の置き場所の中にある）。
#
# **記録とは扱いが違う。** あちらの基準は「戻せないものは残す」だが、保管庫の中身は
# 実行ファイルなので**落とし直せる＝戻せる**。だから `-Purge` を待たずに消す——
# 残すと版1つあたり数十MB が誰にも気づかれずに溜まり続ける。
#
# 名前は実装（`agent_core::version`）と揃える。食い違いは `crates/dist/tests/uninstall.rs` が見張る
$VersionsDirName = 'versions'
$VersionFileNames = @('version-current', 'version-attempt', 'version-state.json')

# **古い置き場所。** v0.1.0 には Windows の道が無く、`HOME` も無いので記録が
# 一時領域（`%LOCALAPPDATA%\Temp\`）へ落ちていた。いまの実行ファイルはそこを
# 知らないので、聞いても返ってこない。
#
# 放っておくと**誰も消せない記録**になるので、`-Purge` のときだけ掃く。名前は
# アプリ名そのものなので、巻き添えの心配は無い。
$LegacyStateDir = if ($env:TEMP) {
    Join-Path $env:TEMP $AppName
} else {
    Join-Path ([System.IO.Path]::GetTempPath()) $AppName
}

function Remove-Target([string]$Target) {
    if (-not (Test-Path -LiteralPath $Target)) { return }
    if ($DryRun) {
        Write-Host "  消す予定: $Target"
        return
    }
    try {
        Remove-Item -LiteralPath $Target -Recurse -Force
        Write-Host "  消しました: $Target"
    } catch {
        # **消せなくても止まらない。** 途中で止まると中途半端に消えた状態が残る
        Write-Warning "  消せませんでした（権限や実行中でないかを確かめてください）: $Target"
    }
}

# 入れた場所を控えから読む。既定と違う場所へ入れた人にも効かせるため
$ReceiptInstallDir = $null
if (Test-Path -LiteralPath $Receipt) {
    try {
        $ReceiptInstallDir = (Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json).install_prefix
    } catch {
        $ReceiptInstallDir = $null
    }
}

# 探す場所は**控えと既定の両方**。片方だけにしない——控えが読めたときに既定を
# 見なくすると、別の場所へ入れ直したあとに控えの書き込みが失敗した場合などに、
# **既定の場所の3本が生き残ったまま「見つかりませんでした」と出る**
$SearchDirs = @($DefaultInstallDir)
if (-not [string]::IsNullOrWhiteSpace($ReceiptInstallDir)) {
    Write-Host "控えに書かれた場所を見ます: $ReceiptInstallDir"
    # 控えが既定を指していることもある。**同じ場所を2回走査しない**
    if ($ReceiptInstallDir -ne $DefaultInstallDir) {
        $SearchDirs = @($ReceiptInstallDir) + $SearchDirs
    }
} else {
    Write-Host '控えが読めないので、既定の場所だけを見ます'
}
Write-Host "見る場所: $($SearchDirs -join ' ')"

# 記録の置き場所は**実行ファイルに聞く**。**消す前に聞く**——聞く相手を先に消したら
# 二度と分からない。設定や環境変数で変えた場所も、これなら対象になる
function Get-StateDirFromBinary {
    foreach ($dir in $SearchDirs) {
        foreach ($candidate in @((Join-Path $dir 'agentdashboard.exe'), (Join-Path (Join-Path $dir 'bin') 'agentdashboard.exe'))) {
            if (-not (Test-Path -LiteralPath $candidate)) { continue }
            try {
                $answer = (& $candidate state-dir 2>$null | Select-Object -First 1)
            } catch {
                continue
            }
            if (-not [string]::IsNullOrWhiteSpace($answer)) { return $answer.Trim() }
        }
    }
    return $null
}

$StateDir = Get-StateDirFromBinary
if ($StateDir) {
    Write-Host "記録の置き場所（実行ファイルに聞きました）: $StateDir"
} else {
    # **黙って既定を消しに行かない。** 聞けなかったことは言う
    $StateDir = $StateDirFallback
    Write-Host "記録の置き場所（実行ファイルに聞けないので既定）: $StateDir"
    Write-Host '  設定で置き場所を変えていた場合は、そちらは消えません'
}

Write-Host ''
Write-Host '== 実行ファイル =='
$found = $false
foreach ($dir in $SearchDirs) {
    foreach ($binary in $Binaries) {
        # 控えの install_prefix は、そのまま置き場所を指す形と、下に bin を持つ形がある
        foreach ($candidate in @((Join-Path $dir $binary), (Join-Path (Join-Path $dir 'bin') $binary))) {
            if (Test-Path -LiteralPath $candidate) {
                $found = $true
                Remove-Target $candidate
            }
        }
    }
}
# **全部の候補を見た後**に判定する
if (-not $found) { Write-Host '  見つかりませんでした（既に消えているようです）' }

Write-Host ''
Write-Host '== インストールの控え =='
Remove-Target $Receipt
# 空になったフォルダだけ畳む。**他のものが入っているなら残す**
if ((-not $DryRun) -and (Test-Path -LiteralPath $ReceiptDir)) {
    if (-not (Get-ChildItem -LiteralPath $ReceiptDir -Force)) {
        Remove-Item -LiteralPath $ReceiptDir -Force
        Write-Host "  消しました: $ReceiptDir"
    }
}

Write-Host ''
Write-Host '== 版の保管庫 =='
# 記録の中にあるが、中身は実行ファイルなので**落とし直せる**。`-Purge` を待たない。
# ポインタと小物も一緒に消す——**残すと入れ直したときに、消えた版を指したまま
# 「指す先が見つかりません」が出続ける**
$versionFound = $false
foreach ($name in @($VersionsDirName) + $VersionFileNames) {
    $target = Join-Path $StateDir $name
    if (Test-Path -LiteralPath $target) {
        $versionFound = $true
        Remove-Target $target
    }
}
if (-not $versionFound) { Write-Host '  ありませんでした' }

Write-Host ''
Write-Host '== 記録（一覧・履歴） =='
if ($Purge) {
    Remove-Target $StateDir
    # 古い版が一時領域へ置いた記録も掃く。**いまの実行ファイルはここを知らない**ので、
    # 聞いても返ってこない。放っておくと誰も消せない記録になる
    if (($LegacyStateDir -ne $StateDir) -and (Test-Path -LiteralPath $LegacyStateDir)) {
        Write-Host '  古い版が一時領域へ置いた記録も見つかりました'
        Remove-Target $LegacyStateDir
    }
} else {
    if (Test-Path -LiteralPath $StateDir) {
        Write-Host "  残しました: $StateDir"
        Write-Host '  （消すと一覧と履歴が戻せません。消すなら -Purge を付けてください）'
    } else {
        Write-Host '  ありませんでした'
    }
    if (($LegacyStateDir -ne $StateDir) -and (Test-Path -LiteralPath $LegacyStateDir)) {
        Write-Host "  残しました（古い版が一時領域へ置いたもの）: $LegacyStateDir"
    }
}

Write-Host ''
Write-Host '== 触っていないもの =='
Write-Host '  PATH への追加（利用者の環境変数）'
Write-Host '  同じ仕組みで入れた他のツールと共有しているため、こちらでは消しません。'
Write-Host '  他に使っているものが無ければ、環境変数の設定から手で消してください。'

Write-Host ''
if ($DryRun) {
    Write-Host '（-DryRun なので、実際には何も消していません）'
} else {
    Write-Host '完了しました。'
}
