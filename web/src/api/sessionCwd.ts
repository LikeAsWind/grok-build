// ============================================
// 会话 cwd 上线路径 —— 单测可测的纯函数
// ============================================

/**
 * 发给后端的 cwd 统一归一化为**正斜杠**（`C:/...`）。
 *
 * 背景（bug: 加载历史聊天记录一直转圈）：后端按 `encode_cwd_dirname(cwd)`
 * 把 cwd 原样 URL-encode 成 session 目录名——正斜杠编成 `%2F`、反斜杠编成
 * `%5C`，是两个不同目录；后端自身不做任何斜杠归一化（`resolve_workspace`
 * 仅 AbsPathBuf 校验）。于是同一个项目会被拆成两份 session 存储：
 *   - Web（曾经 `.replace` 成正斜杠）→ `%2F` 目录（多数派）
 *   - TUI / 原生反斜杠 cwd         → `%5C` 目录（少数派）
 * `session/list` 跨目录聚合所以侧栏都显示，但 `session/load` 按 cwd 只在一个
 * 编码目录里找——前端发哪种斜杠就只能命中哪种目录，命中不到的那个就
 * `Path not found`。
 *
 * 归一化方向选**正斜杠**：磁盘上绝大多数会话（含 brmerp-ac、最新活跃会话）
 * 都在 `%2F` 目录，且原实现注释本意就是「统一用正斜杠」。
 *
 * 注意：这只统一了 Web 这一侧。TUI 仍按原生反斜杠 cwd 落到 `%5C`——
 * 跨客户端（TUI↔Web）的持久统一需在后端 `encode_cwd_dirname` 入口做
 * encode 前归一化（见后续后端任务）。
 */
export function sessionCwdForWire(cwd: string): string {
  return cwd.trim().replace(/\\/g, '/')
}
