# Vibe Keyboard - activate a top-level window by (partial) title.
# Pure ASCII by convention (see memory: ps1 with CJK needs UTF-8 BOM).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File activate-window.ps1 -TitlePart sandbox-A
# Output: ACTIVATED <pid> <title>  or NOTFOUND (exit 1)
param([Parameter(Mandatory = $true)][string]$TitlePart)

Add-Type -Namespace Vibe -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@

$proc = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$TitlePart*" } |
  Select-Object -First 1

if (-not $proc) {
  Write-Output "NOTFOUND"
  exit 1
}
$h = $proc.MainWindowHandle
if ([Vibe.Win]::IsIconic($h)) { [void][Vibe.Win]::ShowWindow($h, 9) } # SW_RESTORE
[void][Vibe.Win]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 200
Write-Output "ACTIVATED $($proc.Id) $($proc.MainWindowTitle)"
