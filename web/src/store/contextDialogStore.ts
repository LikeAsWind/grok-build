// ============================================
// contextDialogStore — 上下文详情弹窗（ContextDetailsDialog）的开关状态
//
// TUI 的 /context 是纯本地动作（Action::ShowContextInfo，直接打开本地面板，
// 不发到服务端——见 slash/commands/context.rs）。Web 端对应的面板是
// ContextDetailsDialog，此前只能从 SidebarFooter 的「查看详情」按钮打开。
// useChatSession::handleCommand 把 /context 拦成本地动作时，需要一个跨
// 组件的开关入口，走这个 store（跟 planApprovalStore 同一模式）。
// ============================================

type Listener = () => void

let _open = false
const _listeners = new Set<Listener>()

export function isContextDialogOpen(): boolean {
  return _open
}

export function setContextDialogOpen(open: boolean) {
  if (_open === open) return
  _open = open
  _listeners.forEach(fn => fn())
}

export function subscribeContextDialog(fn: Listener): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
