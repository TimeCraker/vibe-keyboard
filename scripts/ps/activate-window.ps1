# Vibe Keyboard - activate a top-level window by (partial) title.
# Pure ASCII by convention (ps1 with CJK needs UTF-8 BOM).
#
# VS Code hosts multiple windows in ONE process, so Get-Process /
# MainWindowHandle only ever surfaces one of them. Enumerate top-level
# windows with EnumWindows instead and match by title.
#
# All enumeration happens inside the C# helper: PowerShell scriptblock ->
# EnumWindowsProc delegate conversions do not fire reliably, so the callback
# must live in managed code.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File activate-window.ps1 -TitlePart sandbox-A
#   powershell ... -File activate-window.ps1 -List        # diagnostic: all visible windows
# Output: ACTIVATED <hwnd> <title> | NOTFOUND (exit 1) | (list mode) hwnd | title lines
param(
  [string]$TitlePart = '',
  [switch]$List
)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class VibeWin3 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

  private static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len <= 0) return "";
    var sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static List<string> VisibleWindows() {
    var list = new List<string>();
    EnumWindows((h, lp) => {
      if (IsWindowVisible(h)) {
        string t = Title(h);
        if (t.Length > 0) list.Add(h.ToInt64().ToString() + " | " + t);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);

  // SetForegroundWindow from a background process is silently denied by the
  // OS foreground lock; attach to the foreground thread first.
  private static void ForceForeground(IntPtr h) {
    uint pid;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    SetForegroundWindow(h);
    BringWindowToTop(h);
    if (attached) AttachThreadInput(me, fgThread, false);
  }

  public static string ActivateByTitle(string part) {
    IntPtr target = IntPtr.Zero; string title = "";
    EnumWindows((h, lp) => {
      if (IsWindowVisible(h)) {
        string t = Title(h);
        if (t.Length > 0 && t.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) {
          target = h; title = t;
          return false; // stop
        }
      }
      return true;
    }, IntPtr.Zero);
    if (target == IntPtr.Zero) return "NOTFOUND";
    ForceForeground(target);
    return "ACTIVATED " + target.ToInt64().ToString() + " | " + title;
  }
}
'@

if ($List) {
  [VibeWin3]::VisibleWindows() | ForEach-Object { Write-Output $_ }
  exit 0
}
if (-not $TitlePart) { Write-Output "NOTFOUND"; exit 1 }

$out = [VibeWin3]::ActivateByTitle($TitlePart)
Write-Output $out
if ($out -eq "NOTFOUND") { exit 1 }
Start-Sleep -Milliseconds 200
exit 0
