# Vibe Keyboard global hotkey sidecar (ASCII only on purpose).
# Registers a global hotkey and prints one line per physical press to stdout.
# The Node host reads stdout and runs the same big-key handler as the
# pipe-triggered path.
# params: -Vk <virtual-key> -Mods "CTRL,ALT"  (ALT|CTRL|SHIFT|WIN, + NOREPEAT)
param(
    [int]$Id = 0xB1,
    [string]$Mods = "CTRL,ALT,NOREPEAT",
    [int]$Vk = 0x56
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VibeHotkey {
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint lo, uint hi);
}
"@

$modMap = @{ "ALT" = 0x1; "CTRL" = 0x2; "SHIFT" = 0x4; "WIN" = 0x8; "NOREPEAT" = 0x4000 }
$mods = [uint32]0
foreach ($m in $Mods -split ",") {
    $t = $m.Trim().ToUpperInvariant()
    if ($modMap.ContainsKey($t)) { $mods = $mods -bor $modMap[$t] }
}

if (-not [VibeHotkey]::RegisterHotKey([IntPtr]::Zero, $Id, $mods, [uint32]$Vk)) {
    Write-Output "HOTKEY_REGISTER_FAILED"
    [Console]::Out.Flush()
    exit 1
}
Write-Output "HOTKEY_READY"
[Console]::Out.Flush()

try {
    while ($true) {
        $m = New-Object VibeHotkey+MSG
        $r = [VibeHotkey]::GetMessage([ref]$m, [IntPtr]::Zero, 0, 0)
        if ($r -le 0) { break }
        if ($m.message -eq 0x0312) {
            Write-Output "HOTKEY_PRESSED"
            [Console]::Out.Flush()
        }
    }
}
finally {
    [void][VibeHotkey]::UnregisterHotKey([IntPtr]::Zero, $Id)
}
