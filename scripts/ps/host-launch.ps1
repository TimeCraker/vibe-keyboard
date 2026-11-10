# Vibe Keyboard host launcher for the interactive scheduled task.
# Runs ON THE REAL USER DESKTOP (Default desktop) so the win32 sidecar can
# query/switch the real foreground window. Pure ASCII by convention.
Set-Location C:\Users\TimeCraker\Desktop\my_workspace\vibe-keyboard
node src/host/host.mjs serve *>> C:\Users\TimeCraker\.ccweb\tmp\vibe-host-default.log
