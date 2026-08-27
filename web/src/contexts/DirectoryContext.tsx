// ============================================
// DirectoryContext - 管理当前工作目录
// ============================================

import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import { type ApiPath, getSession } from '../api'
import { useRouter } from '../hooks/useRouter'
import { normalizeToForwardSlash, serverStorage } from '../utils'
import { layoutStore, useLayoutStore } from '../store/layoutStore'
import { serverStore } from '../store/serverStore'
import { DirectoryContext, type DirectoryContextValue } from './DirectoryContext.shared'

const STORAGE_KEY_RECENT = 'opencode-recent-projects'

// 最近使用记录: { [path]: lastUsedAt }
type RecentProjects = Record<string, number>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readRecentProjects(): RecentProjects {
  const recent = serverStorage.getJSON<unknown>(STORAGE_KEY_RECENT)
  if (!isRecord(recent)) return {}

  return Object.fromEntries(
    Object.entries(recent).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  )
}

export function DirectoryProvider({ children }: { children: ReactNode }) {
  // URL dir 只在 home/workbench 路由有意义;session 路由的 cwd 由下面 sessionDirectory 派生
  const { directory: urlDirectory, sessionId: routeSessionId, setDirectory: setUrlDirectory } = useRouter()

  // 从 layoutStore 获取 sidebarExpanded
  const { sidebarExpanded } = useLayoutStore()

  const [recentProjects, setRecentProjects] = useState<RecentProjects>(readRecentProjects)

  const [pathInfo, setPathInfo] = useState<ApiPath | null>(null)

  // session 路由下:从 session 元数据反查 cwd —— 这是 source of truth,不受 URL 影响
  // home/workbench 路由下:sessionDirectory = undefined,fallback 到 urlDirectory
  const [sessionDirectory, setSessionDirectory] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!routeSessionId) {
      setSessionDirectory(undefined)
      return
    }
    // 先清掉旧值,避免切换 session 时短暂显示上一个 session 的 cwd
    setSessionDirectory(undefined)
    let cancelled = false
    void getSession(routeSessionId)
      .then(session => {
        if (cancelled) return
        setSessionDirectory(session?.directory || undefined)
      })
      .catch(() => {
        if (!cancelled) setSessionDirectory(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [routeSessionId])

  // 服务器 ID 切换时切换 per-server 目录;local runtime URL 变化时只刷新 path info。
  useEffect(() => {
    return serverStore.onServerChange((_, reason) => {
      if (reason === 'server-switch') {
        setRecentProjects(readRecentProjects())
        setUrlDirectory(undefined)
      }
      setPathInfo(null)
      // getPath() 依赖已被 stub 的 OpenCodeUI SDK,且 pathInfo 无实际使用者——跳过
    })
  }, [setUrlDirectory])

  // pathInfo 无实际使用者,不再加载(原 getPath() 依赖已废弃的 SDK)

  // 保存 recentProjects 到 per-server storage
  useEffect(() => {
    serverStorage.setJSON(STORAGE_KEY_RECENT, recentProjects)
  }, [recentProjects])

  // 设置当前目录(更新 URL + 记录最近使用)—— 显式用户行为,只走 URL
  const setCurrentDirectory = useCallback(
    (directory: string | undefined) => {
      setUrlDirectory(directory)
      if (directory) {
        setRecentProjects(prev => ({ ...prev, [directory]: Date.now() }))
      }
    },
    [setUrlDirectory],
  )

  // 仅刷新目录的最近时间戳,不切换 currentDirectory
  const touchDirectory = useCallback((path: string) => {
    setRecentProjects(prev => ({ ...prev, [normalizeToForwardSlash(path)]: Date.now() }))
  }, [])

  // 设置侧边栏展开 - 委托给 layoutStore
  const setSidebarExpanded = useCallback((expanded: boolean) => {
    layoutStore.setSidebarExpanded(expanded)
  }, [])

  // currentDirectory 派生:session 路由用 session 元数据,其他路由用 URL
  const currentDirectory = sessionDirectory ?? urlDirectory

  // 稳定化 Provider value,避免每次渲染创建新对象导致子组件不必要重渲染
  const value = useMemo<DirectoryContextValue>(
    () => ({
      currentDirectory,
      setCurrentDirectory,
      recentProjects,
      touchDirectory,
      pathInfo,
      sidebarExpanded,
      setSidebarExpanded,
    }),
    [currentDirectory, setCurrentDirectory, recentProjects, touchDirectory, pathInfo, sidebarExpanded, setSidebarExpanded],
  )

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>
}
