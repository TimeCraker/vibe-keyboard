# Vibe Keyboard 一期软件测试
# 用法: .\scripts\test.ps1 -Suite Software
param(
    [ValidateSet("Software")]
    [string]$Suite = "Software"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

if ($Suite -eq "Software") {
    Write-Host "==> 状态机重放测试 (node --test)"
    Push-Location $root
    try {
        node --test tests/hooks-replay.test.mjs
        if ($LASTEXITCODE -ne 0) { throw "replay tests failed" }
    } finally { Pop-Location }
    Write-Host "软件测试通过。"
}
