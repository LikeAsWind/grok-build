// 首页承载面：仪表盘（用量统计）与 TAPD 工作台是两个独立入口，都在"当前 pane
// 没有会话"时占据主区域。这里只存"选中哪一个"，不持久化——仪表盘是首页，刷新
// 后回到仪表盘。展开/折叠一类的面板内状态各自管理，不进这个 store。

export type HomeView = 'dashboard' | 'workbench'

class HomeViewStore {
  private _view: HomeView = 'dashboard'
  private listeners = new Set<() => void>()

  get view(): HomeView {
    return this._view
  }

  setView(view: HomeView) {
    if (this._view === view) return
    this._view = view
    this.notify()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // 基础类型快照，useSyncExternalStore 直接比较即可，不需要缓存对象
  getSnapshot = () => this._view

  private notify() {
    this.listeners.forEach(fn => fn())
  }
}

export const homeViewStore = new HomeViewStore()
