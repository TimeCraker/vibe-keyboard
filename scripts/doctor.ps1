# Vibe Keyboard 一期环境体检（T01）
# 检查并记录软件链路工具版本；固件工具链（Pico SDK/CMake/Ninja）单独记录状态。
# 输出：控制台 + docs/evidence/phase1/T01-doctor-latest.txt
param(
    [string]$OutDir = ""
)
$ErrorActionPreference = "Continue"
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "..\docs\evidence\phase1" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$report = New-Object System.Collections.Generic.List[string]
function Add-Line($s) { $report.Add($s); Write-Host $s }

Add-Line "=== Vibe Keyboard doctor $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Add-Line ""

function Check($name, $cmd, $argList) {
    try {
        $p = Start-Process -FilePath $cmd -ArgumentList $argList -NoNewWindow -Wait -PassThru `
             -RedirectStandardOutput "$env:TEMP\vibe-dr-out.txt" -RedirectStandardError "$env:TEMP\vibe-dr-err.txt"
        $out = (Get-Content "$env:TEMP\vibe-dr-out.txt" -Raw -ErrorAction SilentlyContinue)
        $err = (Get-Content "$env:TEMP\vibe-dr-err.txt" -Raw -ErrorAction SilentlyContinue)
        $first = (($out, $err | Where-Object { $_ }) -join " ").Trim()
        if ($first.Length -gt 160) { $first = $first.Substring(0, 160) }
        Add-Line ("[OK]   {0,-18} {1}" -f $name, ($first -replace "`r`n", " " -replace "`n", " "))
        return $true
    } catch {
        Add-Line ("[MISS] {0,-18} 未安装或不在 PATH" -f $name)
        return $false
    }
}

Add-Line "--- 软件链路 ---"
Check "Windows"        "cmd.exe" "/c ver"
Check "Node.js"        "node" "--version"
Check "npm"            "cmd.exe" "/c npm --version"
Check "VS Code"        "code" "--version"
Check "Claude Code"    "cmd.exe" "/c claude --version"
Check "PowerShell"     "powershell.exe" "-NoProfile -Command `$PSVersionTable.PSVersion.ToString()"

Add-Line ""
Add-Line "--- .NET（产品目标栈；S0 上位机为 Node 实现，见 T01 证据）---"
Check ".NET SDK"       "dotnet" "--version"

Add-Line ""
Add-Line "--- 固件链路（一期硬件线，T01 固件子项）---"
Check "CMake"          "cmake" "--version"
Check "Ninja"          "ninja" "--version"
$armNone = Get-ChildItem "$env:USERPROFILE\.pico-sdk" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($armNone) { Add-Line "[OK]   Pico SDK 目录     $($armNone.FullName)" }
else { Add-Line "[MISS] Pico SDK          未发现 ~/.pico-sdk（硬件线并行推进时安装）" }

Add-Line ""
Add-Line "--- Codex CLI（混合验证用）---"
$codexPath = "C:\Program Files\WindowsApps\OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0\app\Codex.exe"
if (Test-Path $codexPath) { Add-Line "[OK]   Codex (Store)     $codexPath" }
else { Add-Line "[MISS] Codex CLI         未找到 Store 版安装" }

Add-Line ""
Add-Line "--- 项目工件 ---"
$ext = Test-Path (Join-Path $PSScriptRoot "..\src\vscode-extension\dist\extension.js")
Add-Line ("{0}     VS Code 扩展构建 dist/extension.js" -f ($(if ($ext) { "[OK]  " } else { "[MISS]" })))

$outFile = Join-Path $OutDir "T01-doctor-latest.txt"
$report | Set-Content -Path $outFile -Encoding UTF8
Write-Host ""
Write-Host "报告已写入: $outFile"
