# Codex 混合验证任务卡（sandbox-codex）

运行时由混合验证脚本生成 `tests/fixtures/sandbox-codex/`（gitignored），
并把 `tests/fixtures/codex-hooks-template.json` 中的 `CODEXBINDING` 替换为
实际绑定 ID 写入 `sandbox-codex/.codex/hooks.json`。跑完删除 sandbox 目录即可完全还原。

## 会话提示词（无破坏性）

请用 shell 执行命令 `echo vibe-codex-ok`，除此之外什么都不要做，完成后立即结束回复。

## 验证点

1. Codex hooks（项目层 + `--dangerously-bypass-hook-trust`）事件经 forwarder `--src codex` 入宿主。
2. PermissionRequest 由 codex-permission-hook.mjs 代答：先入队 waiting，宿主 `mcp-allow` 后放行。
3. 与一个 Claude Code 会话同时 waiting 时，队列两项、大键分别跳对终端。
4. 缺口：无 SessionEnd/StopFailure——会话退出与 API 失败显示 unknown / 走过期，记录于 codex-validation.md。
