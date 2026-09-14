<#
.SYNOPSIS
    WSL と Docker の仮想ディスクを縮め、使ったぶんを Windows へ返す。

.DESCRIPTION
    WSL の中でファイルを消しても、Windows から見た空きは戻らない。仮想ディスクは
    一度膨らむと縮まず、`fstrim` も効かない（2026-09-14 実測）。**返す道は
    「WSL を止めて縮める」だけ**である。

    この台本は人が居ないところ（Windows のタスクスケジューラ）から走るので、
    次の3つを設計の芯としている。

    1. **確認待ちを1つも持たない。** `Read-Host` があると誰も答えず永久に止まる
    2. **どこで倒れても、結果を必ず書く。** 書かれないのが最悪の形である——
       起き直った側が「走ったのか、落ちただけなのか」を判定できなくなる
    3. **縮小の失敗と、起こし直しの失敗を混ぜない。** 縮小が成功していれば
       `ok` は真のままで、起こし直せなかったことは `woke` が偽で伝える

    **この台本は走っている claude を全部落とす。** `wsl --shutdown` を含むので、
    WSL の中で動いているものはすべて道連れになる。いつ打つかの判定は
    ダッシュボード側（`agentdashboard host compact run`）が持っている。

.NOTES
    結果は2つのファイルに残る。

      compact-result.json … 機械が読む1行 JSON（起き直ったダッシュボードが拾う）
      compact-wsl.log     … 人が読む記録

    **前後のディスクの空きは Windows 側でしか測れない**ので、ここで測って
    結果 JSON に載せる。WSL の中からでは、止めている最中の値を読めない。
#>

param(
    # 縮める仮想ディスク。空なら自動で探す
    [string]$Ext4Vhdx = "",
    [string]$DockerVhdx = "",

    # 機械が読む結果と、人が読む記録
    [string]$ResultPath = "$env:LOCALAPPDATA\AgentDashboard\compact-result.json",
    [string]$LogPath = "$env:LOCALAPPDATA\AgentDashboard\compact-wsl.log",

    # WSL が止まるのを待つ上限。**超えたら縮めずに終わる**（止まっていない
    # ディスクを diskpart は掴めない）
    [int]$WslStopTimeoutSec = 90,

    # Docker Desktop が穏やかに終わるのを待つ上限。超えたら強制で落とす
    [int]$DockerStopWaitSec = 60,

    # 起こし直す WSL のディストロ名
    [string]$Distro = "Ubuntu-24.04"
)

$ErrorActionPreference = "Stop"

# **これを立てないと `wsl.exe` の出力が UTF-16LE になる。** PowerShell から素朴に
# 文字列比較すると1文字ごとに NUL が挟まって見え、「止まった」の判定が常に外れる
$env:WSL_UTF8 = "1"

function Now-Rfc3339 {
    (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

# ファイルの大きさをバイトで返す。**測れなければ $null**（「測っていない」と
# 「0 バイトだった」は別物なので、0 に倒さない）
function Get-SizeOrNull([string]$path) {
    if (-not $path) { return $null }
    try { return (Get-Item -LiteralPath $path).Length } catch { return $null }
}

function Get-FreeOrNull {
    try { return (Get-PSDrive C).Free } catch { return $null }
}

# 走っている WSL のディストロ名を配列で返す。
#
# **`wsl -l -v` の表は解析しない。** 桁揃えにも見出しの訳語にも依存してしまう。
# `--running --quiet` は走っているものだけを1行ずつ出すので、**空なら全部止まっている**。
#
# **1つも走っていないとき非ゼロで返ることがある**ので、ここだけ $ErrorActionPreference
# から逃がす（倒れると「止まったのに止まらなかった」と記録してしまう）。
function Get-RunningDistros {
    try {
        $out = & wsl.exe -l --running --quiet 2>$null
    } catch {
        return @()
    }
    if (-not $out) { return @() }
    return @($out | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# ---------------------------------------------------------------------------
# 結果を先に組む。**`ok` は偽で初期化する。**
#
# 各段の末尾で書き出す形にすると、「書き出す行そのものに到達しない倒れ方」が
# 必ず残る。先に組んで finally で書けば、どこで倒れても結果は残る。

$result = [ordered]@{
    ok                  = $false
    started_at          = Now-Rfc3339
    finished_at         = $null
    c_before_bytes      = $null
    c_after_bytes       = $null
    ext4_before_bytes   = $null
    ext4_after_bytes    = $null
    docker_before_bytes = $null
    docker_after_bytes  = $null
    woke                = $false
    reason              = "最後まで進まなかった"
}

try { Start-Transcript -Path $LogPath -Force | Out-Null } catch { }

try {
    # -----------------------------------------------------------------------
    # 縮める相手を決める

    if (-not $Ext4Vhdx) {
        # 複数のディストロが入っている機械がある。**いちばん大きいものを採る**
        $found = Get-ChildItem -Path "$env:LOCALAPPDATA\Packages\CanonicalGroupLimited.Ubuntu*\LocalState\ext4.vhdx" `
            -ErrorAction SilentlyContinue | Sort-Object Length -Descending
        if ($found) { $Ext4Vhdx = $found[0].FullName }
    }
    if (-not $Ext4Vhdx -or -not (Test-Path -LiteralPath $Ext4Vhdx)) {
        throw "WSL の仮想ディスクが見つからない（-Ext4Vhdx で渡すこと）"
    }

    if (-not $DockerVhdx) {
        $candidate = "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx"
        if (Test-Path -LiteralPath $candidate) { $DockerVhdx = $candidate }
    }
    # **Docker が無い機械では、無いまま進む。** これは異常ではない

    # -----------------------------------------------------------------------
    # 段1：前の値を控える

    $result.c_before_bytes = Get-FreeOrNull
    $result.ext4_before_bytes = Get-SizeOrNull $Ext4Vhdx
    $result.docker_before_bytes = Get-SizeOrNull $DockerVhdx

    # -----------------------------------------------------------------------
    # 段2・段3：Docker を止める
    #
    # **`wsl --shutdown` より先である。** Docker Desktop が docker_data.vhdx を
    # 掴んでいるので、逆順では diskpart が縮められない。
    #
    # **穏やかに止められなくても倒れない。** 最後に強制で落とす道があるので、
    # ここで例外にすると、その道が使えない機械で必ず失敗する

    $dockerCli = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe"
    if (Test-Path -LiteralPath $dockerCli) {
        try { & $dockerCli desktop stop 2>&1 | Out-Null } catch { }
    }

    $deadline = (Get-Date).AddSeconds($DockerStopWaitSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 2
    }
    # 残っていれば強制で落とす。**箱の書きかけが失われうるが、止まらないと縮められない**
    Stop-Process -Name "Docker Desktop" -Force -ErrorAction SilentlyContinue

    # -----------------------------------------------------------------------
    # 段4：WSL の窓を落とす
    #
    # 開きっぱなしの窓が1つでも残っていると、`--shutdown` の直後に起こし直されて
    # diskpart が断られる（2026-09-07 に実際に踏んだ）。
    #
    # **`wslservice` はこの一覧に入れないこと。** あれは Windows のサービスで、
    # 落とすと WSL そのものが壊れる

    Stop-Process -Name wsl, wslhost, wslrelay -Force -ErrorAction SilentlyContinue

    # -----------------------------------------------------------------------
    # 段5・段6：止めて、止まったことを確かめる

    & wsl.exe --shutdown
    $deadline = (Get-Date).AddSeconds($WslStopTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Get-RunningDistros).Count -eq 0) { break }
        Start-Sleep -Seconds 2
    }
    $stillRunning = Get-RunningDistros
    if ($stillRunning.Count -gt 0) {
        throw "WSL が $WslStopTimeoutSec 秒たっても止まらなかった（$($stillRunning -join ', ')）"
    }

    # -----------------------------------------------------------------------
    # 段7：2枚を縮める
    #
    # **`attach vdisk readonly` を必ず通す。** これがファイルシステム対応の圧縮を
    # 有効にし、かつ書き込みを弾く。実際に報告されている破損事例は、どれも
    # readonly を省いた形である。
    #
    # **`detach` は `compact` の後にしか書かない。** 圧縮の完了前に切り離すと、
    # Microsoft の仕様上そこで失敗する。
    #
    # 手順ファイルはその場で作る。**リポジトリに置かない**——パスが機械ごとに
    # 違うので、置くと必ず書き換えが要る

    foreach ($vhdx in @($Ext4Vhdx, $DockerVhdx)) {
        if (-not $vhdx) { continue }

        $steps = Join-Path $env:TEMP ("compact-" + [guid]::NewGuid().ToString("N") + ".txt")
        $lines = @(
            "select vdisk file=`"$vhdx`""
            "attach vdisk readonly"
            "compact vdisk"
            "detach vdisk"
            "exit"
        )
        # diskpart は BOM 付きのファイルを読めないことがあるので ASCII で書く
        Set-Content -LiteralPath $steps -Value $lines -Encoding Ascii
        try {
            & diskpart.exe /s $steps
            if ($LASTEXITCODE -ne 0) {
                throw "diskpart が $LASTEXITCODE を返した（$vhdx）"
            }
        } finally {
            Remove-Item -LiteralPath $steps -Force -ErrorAction SilentlyContinue
        }
    }

    # ここまで来たら縮小は成功している。**この後の起こし直しで失敗しても、
    # 縮小の成否は変えない**
    $result.ok = $true
    $result.reason = $null

    # -----------------------------------------------------------------------
    # 段8・段9・段10：起こし直す

    $dockerApp = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path -LiteralPath $dockerApp) {
        try { Start-Process -FilePath $dockerApp | Out-Null } catch { }
    }

    foreach ($attempt in 1..2) {
        try { & wsl.exe -d $Distro -- true } catch { }
        Start-Sleep -Seconds 5
        if ((Get-RunningDistros).Count -gt 0) {
            $result.woke = $true
            break
        }
    }
    # **起こせなくても ok は真のまま。** 起き直った側は woke=false の記録を見て
    # 「人が起こした」と分かる
} catch {
    $result.ok = $false
    $result.reason = $_.Exception.Message
} finally {
    # -----------------------------------------------------------------------
    # 段11：結果を書く。**ここへは必ず到達する**

    # 測る側で倒れても、書き出す行には届かせる
    try {
        $result.finished_at = Now-Rfc3339
        $result.c_after_bytes = Get-FreeOrNull
        $result.ext4_after_bytes = Get-SizeOrNull $Ext4Vhdx
        $result.docker_after_bytes = Get-SizeOrNull $DockerVhdx
    } catch { }

    try {
        $dir = Split-Path -Parent $ResultPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $json = $result | ConvertTo-Json -Compress -Depth 3

        # **`Set-Content -Encoding UTF8` を使わないこと。** Windows PowerShell 5.1 の
        # それは BOM を書き、読む側（Rust の serde_json）が落ちる。しかも reason に
        # 日本語を入れた回だけ読めなくなる——**失敗した回の理由だけが読めない**
        # という、いちばん困る形になる
        [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # ここで倒れたら打つ手が無い。せめて人が読む記録には残す
        Write-Error "結果を書けなかった: $($_.Exception.Message)"
    }

    try { Stop-Transcript | Out-Null } catch { }
}
