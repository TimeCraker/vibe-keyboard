# Vibe Keyboard 构建（一期软件）
# 用法: .\scripts\build.ps1 -Target Host|Extension|All  （默认 All）
param(
    [ValidateSet("Host", "Extension", "All")]
    [string]$Target = "All"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

if ($Target -in @("Extension", "All")) {
    Write-Host "==> 构建扩展 (esbuild + tsc)"
    Push-Location (Join-Path $root "src\vscode-extension")
    try {
        npx tsc --noEmit
        if ($LASTEXITCODE -ne 0) { throw "tsc --noEmit failed" }
        node esbuild.mjs
        if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }
        Write-Host "    OK -> src/vscode-extension/dist/extension.js"
    } finally { Pop-Location }
}

if ($Target -in @("Host", "All")) {
    Write-Host "==> 构建上位机 (Node 零依赖，语法检查)"
    # node --check 逐文件语法验证；运行冒烟在 test.ps1 中
    $files = @(
        "src\host\host.mjs",
        "src\host\lib\statemachine.mjs",
        "src\host\lib\adapters.mjs",
        "src\host\lib\hub.mjs",
        "src\host\lib\screen.mjs",
        "src\hook-forwarder\forward.mjs"
    )
    foreach ($f in $files) {
        node --check (Join-Path $root $f)
        if ($LASTEXITCODE -ne 0) { throw "node --check failed: $f" }
    }
    Write-Host "    OK -> 6 个模块语法通过"
    if (Test-Path "$env:USERPROFILE\.dotnet\dotnet.exe") {
        Write-Host "==> .NET SDK 可用（产品 C# 上位机端口可用时启用）"
    }
}

Write-Host "构建完成。"
