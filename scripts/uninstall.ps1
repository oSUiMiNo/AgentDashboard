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
# 記録の置き場所。**実装の既定と揃える**
$StateDir = if ($env:XDG_STATE_HOME) {
    Join-Path $env:XDG_STATE_HOME $AppName
} else {
    Join-Path $HOME ".local\state\$AppName"
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
$InstallDir = $null
if (Test-Path -LiteralPath $Receipt) {
    try {
        $InstallDir = (Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json).install_prefix
    } catch {
        $InstallDir = $null
    }
}
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = $DefaultInstallDir
    Write-Host "控えが読めないので、既定の場所を見ます: $InstallDir"
} else {
    Write-Host "控えに書かれた場所を見ます: $InstallDir"
}

Write-Host ''
Write-Host '== 実行ファイル =='
$found = $false
foreach ($binary in $Binaries) {
    # 控えの install_prefix は、そのまま置き場所を指す形と、下に bin を持つ形がある
    foreach ($candidate in @((Join-Path $InstallDir $binary), (Join-Path (Join-Path $InstallDir 'bin') $binary))) {
        if (Test-Path -LiteralPath $candidate) {
            $found = $true
            Remove-Target $candidate
        }
    }
}
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
Write-Host '== 記録（一覧・履歴） =='
if ($Purge) {
    Remove-Target $StateDir
} elseif (Test-Path -LiteralPath $StateDir) {
    Write-Host "  残しました: $StateDir"
    Write-Host '  （消すと一覧と履歴が戻せません。消すなら -Purge を付けてください）'
} else {
    Write-Host '  ありませんでした'
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
