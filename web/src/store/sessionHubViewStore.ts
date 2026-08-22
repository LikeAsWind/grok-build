export type SessionHubViewMode = 'list' | 'folder'

const STORAGE_KEY = 'sessionHubViewMode'
const EXPANDED_PROJECTS_KEY = 'sessionHubExpandedProjects'
const MANUALLY_TOUCHED_KEY = 'sessionHubManuallyTouched'

class SessionHubViewStore {
  private _viewMode: SessionHubViewMode = 'list'
  private _expandedProjects: Set<string> = new Set()
  private _manuallyTouched: Set<string> = new Set()
  private _snapshot = this.createSnapshot()
  private listeners = new Set<() => void>()

  constructor() {
    // 从 localStorage 恢复
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'folder') this._viewMode = 'folder'

    try {
      const expandedJson = localStorage.getItem(EXPANDED_PROJECTS_KEY)
      if (expandedJson) {
        this._expandedProjects = new Set(JSON.parse(expandedJson))
      }

      const touchedJson = localStorage.getItem(MANUALLY_TOUCHED_KEY)
      if (touchedJson) {
        this._manuallyTouched = new Set(JSON.parse(touchedJson))
      }
    } catch {}

    this._snapshot = this.createSnapshot()
  }

  get viewMode() {
    return this._viewMode
  }

  setViewMode(mode: SessionHubViewMode) {
    this._viewMode = mode
    localStorage.setItem(STORAGE_KEY, mode)
    this._snapshot = this.createSnapshot()
    this.notify()
  }

  toggleViewMode() {
    this.setViewMode(this._viewMode === 'list' ? 'folder' : 'list')
  }

  /**
   * 用户点击展开/折叠项目
   */
  toggleProject(projectId: string) {
    // 标记为"用户手动操作过"
    this._manuallyTouched.add(projectId)
    this.saveManuallyTouched()

    // 切换展开状态
    if (this._expandedProjects.has(projectId)) {
      this._expandedProjects.delete(projectId)
    } else {
      this._expandedProjects.add(projectId)
    }
    this.saveExpandedProjects()
    this._snapshot = this.createSnapshot()
    this.notify()
  }

  /**
   * 首次默认展开当前工作目录——仅在用户未手动操作过该项目时生效
   */
  ensureDefaultExpanded(projectId: string) {
    // 如果用户手动操作过，不覆盖用户意图
    if (this._manuallyTouched.has(projectId)) return

    // 如果还没展开，默认展开
    if (!this._expandedProjects.has(projectId)) {
      this._expandedProjects.add(projectId)
      this.saveExpandedProjects()
      this._snapshot = this.createSnapshot()
      this.notify()
    }
  }

  private saveExpandedProjects() {
    localStorage.setItem(
      EXPANDED_PROJECTS_KEY,
      JSON.stringify([...this._expandedProjects]),
    )
  }

  private saveManuallyTouched() {
    localStorage.setItem(
      MANUALLY_TOUCHED_KEY,
      JSON.stringify([...this._manuallyTouched]),
    )
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    this.listeners.forEach(fn => fn())
  }

  // 使用稳定 snapshot，避免每次返回新对象
  private createSnapshot() {
    return {
      viewMode: this._viewMode,
      expandedProjects: new Set(this._expandedProjects),
    }
  }

  getSnapshot = () => this._snapshot
}

export const sessionHubViewStore = new SessionHubViewStore()
