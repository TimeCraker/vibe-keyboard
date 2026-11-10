# Vibe Keyboard Win32 ops sidecar (ASCII only on purpose).
# Line protocol on stdin, one reply line per command on stdout:
#   foreground             -> FG|<hwnd>|<pid>|<procname>
#   activate <hwnd>        -> ACT|<setfg>|<isfg>     (0/1)
#   activate_attach <hwnd> -> ACTA|<setfg>|<isfg>    (AttachThreadInput path)
#   minimize <hwnd>        -> MIN|<ok>
#   pid_hwnd <pid>         -> PIDHW|<hwnd>
#   quit                   -> BYE
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class VibeWin {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    public static List<string> VisibleWindows() {
        var list = new List<string>();
        EnumWindows((h, lp) => {
            if (IsWindowVisible(h)) {
                int len = GetWindowTextLength(h);
                if (len > 0) {
                    var sb = new StringBuilder(len + 1);
                    GetWindowText(h, sb, sb.Capacity);
                    list.Add(h.ToInt64().ToString() + " | " + sb.ToString());
                }
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

function Get-PidOf([IntPtr]$h) {
    $p = [uint32]0
    [void][VibeWin]::GetWindowThreadProcessId($h, [ref]$p)
    return $p
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $parts = $line.Trim() -split "\s+"
    if ($parts.Count -lt 1 -or $parts[0] -eq "") { continue }
    $cmd = $parts[0]
    switch ($cmd) {
        "foreground" {
            $h = [VibeWin]::GetForegroundWindow()
            $p = Get-PidOf $h
            $pn = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
            Write-Output ("FG|{0}|{1}|{2}" -f $h.ToInt64(), $p, $pn)
        }
        "activate" {
            $h = [IntPtr][int64]$parts[1]
            $ok = [VibeWin]::SetForegroundWindow($h)
            Start-Sleep -Milliseconds 40
            $fg = [VibeWin]::GetForegroundWindow()
            Write-Output ("ACT|{0}|{1}" -f ($(if ($ok) {1} else {0})), ($(if ($fg -eq $h) {1} else {0})))
        }
        "activate_attach" {
            $h = [IntPtr][int64]$parts[1]
            $fgPid = [uint32]0
            $fgThread = [VibeWin]::GetWindowThreadProcessId([VibeWin]::GetForegroundWindow(), [ref]$fgPid)
            $tPid = [uint32]0
            $tThread = [VibeWin]::GetWindowThreadProcessId($h, [ref]$tPid)
            $me = [VibeWin]::GetCurrentThreadId()
            [void][VibeWin]::AttachThreadInput($me, $fgThread, $true)
            [void][VibeWin]::AttachThreadInput($me, $tThread, $true)
            [void][VibeWin]::BringWindowToTop($h)
            [void][VibeWin]::ShowWindow($h, 9)
            $ok = [VibeWin]::SetForegroundWindow($h)
            Start-Sleep -Milliseconds 80
            $fg = [VibeWin]::GetForegroundWindow()
            if ($fg -ne $h) {
                # foreground-lock bypass: a synthetic ALT press makes the OS
                # treat us as user-interactive, unblocking SetForegroundWindow
                [void][VibeWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
                [void][VibeWin]::SetForegroundWindow($h)
                [void][VibeWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 100
                $fg = [VibeWin]::GetForegroundWindow()
            }
            if ($fg -ne $h) {
                # last resort: min+restore forces activation (visible flicker)
                [void][VibeWin]::ShowWindow($h, 6)
                Start-Sleep -Milliseconds 80
                [void][VibeWin]::ShowWindow($h, 9)
                Start-Sleep -Milliseconds 150
                $fg = [VibeWin]::GetForegroundWindow()
            }
            [void][VibeWin]::AttachThreadInput($me, $fgThread, $false)
            [void][VibeWin]::AttachThreadInput($me, $tThread, $false)
            Write-Output ("ACTA|{0}|{1}" -f ($(if ($ok) {1} else {0})), ($(if ($fg -eq $h) {1} else {0})))
        }
        "minimize" {
            $h = [IntPtr][int64]$parts[1]
            $ok = [VibeWin]::ShowWindowAsync($h, 6)
            Write-Output ("MIN|{0}" -f ($(if ($ok) {1} else {0})))
        }
        "pid_hwnd" {
            $tp = [int]$parts[1]
            $found = [long]0
            Get-Process -Id $tp -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.MainWindowHandle -ne 0) { $found = $_.MainWindowHandle.ToInt64() }
            }
            Write-Output ("PIDHW|{0}" -f $found)
        }
        "list_windows" {
            # one line per visible top-level window: "<hwnd> | <title>"
            foreach ($line in [VibeWin]::VisibleWindows()) { Write-Output ("W|$line") }
            Write-Output "WEND"
        }
        "quit" {
            Write-Output "BYE"
        }
        default {
            Write-Output ("ERR|unknown|" + $cmd)
        }
    }
    [Console]::Out.Flush()
    if ($cmd -eq "quit") { break }
}
