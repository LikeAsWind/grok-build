# Web UI 对话交互手动测试清单（对标 TUI）

> 目的：在浏览器页面上逐项验证 Web UI 已实现的对话交互与 TUI（`xai-grok-pager`）对标组件行为一致。
> 每项给出 **TUI 对标组件 / 操作步骤 / 预期表现**。按 A→E 顺序过一遍即覆盖全部对话场景。
>
> 启动：`grok web --secret <key>` → `http://127.0.0.1:2420/#key=<key>`。
> 自动化对照：`web/src/api/acpBridge.conversation.test.ts`（转译层 12 用例）+ `acpBridge.test.ts`（核心回路 5 用例）。
> 记录方式：每项后的 `[ ]` 打勾；不符合预期的记下 **编号 + 现象 + 复现步骤**。

---

## A. 核心消息回路

### A1. 流式文本回复
- **TUI 对标**：主聊天区流式渲染（`agent_message_chunk`）
- **操作**：新建会话，发送「用三句话解释一下这个仓库是干什么的」
- **预期**：
  - [ ] 回复流式逐字出现，不是整段闪现
  - [ ] Markdown 正确渲染（代码块高亮、列表、表格）
  - [ ] 流式期间显示 streaming 状态，结束后回到 idle

### A2. Thinking / Reasoning 折叠
- **TUI 对标**：thinking 折叠块（`agent_thought_chunk`）
- **操作**：发送一个需要思考的问题（如「比较三种方案的优劣再给结论」）
- **预期**：
  - [ ] 正文之前出现独立的 reasoning 区块，与正文分开
  - [ ] reasoning 与正文交错时各自新开区块，顺序正确
  - [ ] 设置 → 外观切换 Reasoning 显示模式（capsule / italic / markdown）三种都生效

### A3. 中止回复
- **TUI 对标**：Esc 中止（`session/cancel`）
- **操作**：发送一个长任务（如「详细解释 web/src 下每个目录」），流式期间点中止
- **预期**：
  - [ ] 回复立即停止，已生成内容保留
  - [ ] 会话回到 idle，可以继续发下一条消息

### A4. Follow-up 队列
- **TUI 对标**：`queue_pane` / 流式期间排队输入
- **操作**：agent 正在回复时，再输入一条消息发送
- **预期**：
  - [ ] 消息进入 follow-up 队列，InputToolbar 出现队列徽章
  - [ ] 当前回合结束后队列消息自动发出
  - [ ] 队列里的消息可以在发出前移除

### A5. 长回复滚动
- **TUI 对标**：scrollback / 滚动锁定
- **操作**：让 agent 输出很长的回复，期间手动往上滚
- **预期**：
  - [ ] 自动跟随滚动到底部；手动上滚后不再强制拉回
  - [ ] 回到底部后恢复自动跟随

---

## B. 工具调用与卡片

### B1. 只读工具卡片
- **TUI 对标**：tool_call 卡片（read / ls / grep）
- **操作**：发送「读一下 CLAUDE.md 的前 20 行，再用 ls 看下 web/src 目录」
- **预期**：
  - [ ] 出现工具卡片，状态 running → completed
  - [ ] 卡片展开可见输入参数和输出内容
  - [ ] 文本 → 卡片 → 文本顺序正确（卡片后的文字不混入前一段）

### B2. 写文件 + diff 卡片
- **TUI 对标**：edit 工具 diff 渲染
- **操作**：发送「在项目根目录建 test-tmp.txt 写两行内容，然后把第二行改成 hello」（权限按 3 次允许）
- **预期**：
  - [ ] Write / Edit 卡片显示 diff（旧文本/新文本）
  - [ ] 设置里切换 diff 样式后渲染跟随变化
  - [ ] 测完让 agent 删掉 test-tmp.txt

### B3. 工具失败态
- **TUI 对标**：tool_call 失败样式
- **操作**：发送「运行 bash 命令 `exit 1`，再读一个不存在的文件 /nope/xx」
- **预期**：
  - [ ] 失败的卡片显示 error 态（区别于 completed）
  - [ ] 错误输出可展开查看，agent 继续后续回复不中断

### B4. 后台任务完成卡片
- **TUI 对标**：`tasks_pane` 通知（`task_completed`）
- **操作**：发送「在后台跑一个 sleep 5 的 bash 命令，然后告诉我结果」
- **预期**：
  - [ ] 任务完成时会话内出现「✅ Task … completed」内联系统消息

---

## C. 弹窗类交互（服务端发起）

### C1. 权限弹窗 — 允许
- **TUI 对标**：`permission_view`
- **前置**：确认 `[ui] yolo` 未开启（设置 → 表单）
- **操作**：发送「在项目根目录创建 test-perm.txt」
- **预期**：
  - [ ] 弹出权限框，显示工具名 + 参数
  - [ ] 「允许一次」后工具执行并出卡片

### C2. 权限弹窗 — 拒绝
- **操作**：再发一次同样请求，选「拒绝」
- **预期**：
  - [ ] agent 收到拒绝，不执行该操作，正常回复（不卡死、不转圈）

### C3. 权限弹窗 — 流式中到达
- **操作**：发一个先解释后写文件的任务，权限弹窗在文字流式中弹出
- **预期**：
  - [ ] 弹窗不打断已渲染内容；处理后流式继续

### C4. AskUserQuestion 弹窗
- **TUI 对标**：`question_view`
- **操作**：发送「用 AskUserQuestion 问我一个二选一的问题」
- **预期**：
  - [ ] 弹出问题框，header + 选项可点
  - [ ] 选择后 agent 收到答案并继续
  - [ ] 「其他」入口可输入自定义文本
- **多问题变体**：发送「一次问我两个问题，每个两个选项」→ [ ] 两个问题都展示、都能作答

### C5. Plan 审批 — 弹窗批准
- **TUI 对标**：`plan_approval_view`
- **前置**：`[ui] yolo` = false；模式切到 **plan**
- **操作**：发送「计划一下怎么给 README 加一个 FAQ 章节」
- **预期**：
  - [ ] agent 完成规划调 `x.ai/exit_plan_mode` 时**弹出 Plan Approval 弹窗**（不是自动放行）
  - [ ] 弹窗里能看到 plan 条目内容
  - [ ] 批准后 agent 退出 plan 模式开始执行

### C6. Plan 审批 — 拒绝
- **操作**：重复 C5，这次拒绝
- **预期**：
  - [ ] agent 停留在 plan 模式，不执行任何写操作

### C7. Plan 审批 — yolo 自动批准
- **操作**：设置 `[ui] yolo` = true，重复 C5
- **预期**：
  - [ ] 不弹窗，自动批准直接执行
  - [ ] 测完把 yolo 改回 false

---

## D. 会话内状态与卡片

### D1. Todo 卡片
- **TUI 对标**：`todo_pane`（`plan` notification）
- **操作**：发送「把"给 README 加 FAQ"拆成 4 个 todo 并逐个标记完成」
- **预期**：
  - [ ] InputFooter 出现 todo 列表
  - [ ] 状态实时流转 pending → in_progress → completed
  - [ ] 切走再切回会话，todo 状态保留

### D2. Subagent 卡片与子会话跳转
- **TUI 对标**：子会话跟踪（`subagent_spawned/finished`）
- **操作**：发送「用一个 Explore 子代理查一下 web/src/store 下有哪些 store」
- **预期**：
  - [ ] 出现「🤖 Subagent started」/「✅ Subagent finished」内联卡片
  - [ ] SubtaskPartView 卡片「查看完整会话」可跳转到子会话，能返回父会话
  - [ ] 子会话里能看到子代理自己的工具调用过程

### D3. Compaction 通知
- **TUI 对标**：auto-compact 提示（`auto_compact_started/completed`）
- **操作**：长对话触发自动压缩（或后端配置低阈值触发）
- **预期**：
  - [ ] 出现「🔄 Compacting context…」和「✅ Context compacted」内联消息
  - [ ] 压缩后对话可继续，历史不丢

### D4. 错误 / 重试卡片
- **TUI 对标**：采样失败提示（`retry_state`）
- **操作**：设置里把模型 API key 改成无效值，发一条消息
- **预期**：
  - [ ] 出现结构化错误卡片（RetryPartView），可展开看 error_type
  - [ ] 会话回到 idle，不白屏、不永久转圈
  - [ ] key 改回后同会话恢复正常

### D5. 会话标题自动更新
- **TUI 对标**：session_title（`session_info_update`）
- **操作**：新会话发第一条消息
- **预期**：
  - [ ] 侧栏会话标题从默认值自动更新为摘要标题

---

## E. 输入增强 / 会话管理 / 环境

### E1. 斜杠命令
- **TUI 对标**：`slash_dropdown`（`available_commands_update`）
- **操作**：输入框敲 `/`
- **预期**：
  - [ ] 弹出命令菜单，可搜索过滤，键盘上下选择 + Enter
  - [ ] 前端命令与后端命令都在列表里；选 `/compact` 之类能实际执行

### E2. @ 文件提及 + 附件
- **TUI 对标**：`file_search` / prompt 附件
- **操作**：敲 `@` 输入 `CLAUDE` 选中文件；再从文件树拖一个文件到输入框
- **预期**：
  - [ ] `@` 弹出文件搜索下拉，选中后以提及 chip 插入
  - [ ] 拖拽同样生成提及/附件
  - [ ] 发送后 agent 实际读到了该文件内容

### E3. 模型 / 模式切换
- **TUI 对标**：状态栏切换器（`set_model` / `set_mode` / `current_mode_update` / `model_changed`）
- **操作**：Header 切换模型；切换模式（default / plan / accept-edits）
- **预期**：
  - [ ] 切换立即生效，发消息验证新模型在响应
  - [ ] 模式切换后 agent 行为对应变化（plan 模式只读）
  - [ ] 开两个浏览器标签连同一后端，一边切模型另一边同步（`model_changed` 推送）

### E4. 会话列表 / 新建 / 删除 / 历史回放
- **TUI 对标**：`session_picker`
- **操作**：新建第二个会话 → 切回第一个 → 删除第二个
- **预期**：
  - [ ] 切换后历史完整回放：用户消息、回复、reasoning、工具卡片都在（`user_message_chunk` 回放路径）
  - [ ] 回放的消息不闪烁、顺序正确
  - [ ] 删除后列表即时刷新

### E5. Fork 会话
- **TUI 对标**：fork（`x.ai/session/fork`）
- **操作**：对历史中某条消息点 fork
- **预期**：
  - [ ] 新会话包含 fork 点之前的完整历史，之后的不带
  - [ ] 原会话不受影响

### E6. Rewind（消息级 undo / redo）
- **TUI 对标**：`rewind`（消息级）
- **操作**：连发 2-3 条消息，对较早一条 revert，再 unrevert
- **预期**：
  - [ ] revert 后该消息之后的内容隐藏
  - [ ] unrevert 恢复全部
  - [ ]（已知缺口：多检查点面板 `x.ai/rewind/points` 未实现，不测）

### E7. 内嵌终端
- **TUI 对标**：内嵌 PTY
- **操作**：打开底部面板终端 tab（快捷键或工具栏），敲 `echo hi`、`dir`
- **预期**：
  - [ ] xterm 连上 PTY，输入输出正常，中文不乱码
  - [ ] 新开第二个终端 tab、关闭 tab 正常
  - [ ] 切换会话后终端仍可用；调整面板高度终端自适应 resize

### E8. 断线重连
- **TUI 对标**：（TUI 无此问题；Web 特有可靠性）
- **操作**：对话中途重启后端（`grok web` 停掉再起），或断网几秒
- **预期**：
  - [ ] UI 显示断线状态，恢复后自动重连
  - [ ] 重连后会话列表和当前会话历史恢复，pending 的权限/问题请求重新拉取
  - [ ] 不产生重复消息

### E9. 多后端切换 + 工作目录
- **TUI 对标**：（对标 TUI 启动参数 `--cwd`）
- **操作**：Header 服务器切换器查看健康状态；DirBrowserModal 选一个新工作目录建会话
- **预期**：
  - [ ] 切换服务器后 acpBridge 自动重连，会话列表来自新后端
  - [ ] 新会话的 `@` 提及和工具执行以新目录为基准

### E10. 中英 i18n + 主题
- **TUI 对标**：主题系统
- **操作**：切换语言（中/英）、切换主题（亮/暗）
- **预期**：
  - [ ] 上述所有弹窗、卡片、菜单文案跟随语言切换
  - [ ] 主题切换后终端、代码高亮、diff 配色同步

---

## 已知缺口（预期不可用，跳过不算失败）

MCP 运行时面板、Skills 面板、Cron / 定时任务 UI、Rewind 多检查点面板、Subagent 树状视图、Worktree 生命周期、历史搜索、Memory 面板、`/btw` 内联问答、完整 usage 面板。详见 `CLAUDE.md` 已知缺口。

## 结果记录

| 日期 | 版本(commit) | 通过 | 失败项 | 备注 |
|---|---|---|---|---|
| | | /38 | | |
