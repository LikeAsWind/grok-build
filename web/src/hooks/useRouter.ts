import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { normalizeToForwardSlash, serverStorage } from '../utils'
import { STORAGE_KEY_LAST_DIRECTORY } from '../constants/storage'
import { useIsMobile } from './useIsMobile'

/**
 * Hash 路由,支持 directory 参数
 * 格式: #/session/{sessionId}?dir={path} 或 #/?dir={path} 或 #/workbench[?dir={path}]
 *
 * 这里使用模块级 route store,而不是每个 useRouter() 各自 useState。
 * 原因:App、DirectoryProvider、Settings 都会消费路由;如果各自持有本地 state,
 * replaceState 只会更新当前实例其他实例看不到,导致侧边栏目录/项目高亮错乱。
 *
 * workbenchDirectory 用 null 表示"在 #/workbench 路由上但还没选目录",这样
 * App.tsx 里的 isWorkbenchActive 可以用 !== undefined 区分"在工作台"和"不在工作台",
 * 而目录是否已选则由 WorkbenchPage 内部用 urlDirectory || defaultDirectory fallback。
 */

interface RouteState {
  sessionId: string | null
  directory: string | undefined
  /**
   * 工作台视图选中的目录。
   * - undefined = 当前不在工作台
   * - null      = 在工作台路由 (#/workbench) 但还没显式选目录
   * - string    = 在工作台且选了这个目录
   */
  workbenchDirectory: string | null | undefined
}

type Listener = () => void

const listeners = new Set<Listener>()
let routeSnapshot: RouteState | null = null
let isListening = false

function decodeDirectoryParam(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseHash(): RouteState {
  const hash = window.location.hash
  const [path, queryString] = hash.split('?')

  let directory: string | undefined
  if (queryString) {
    const dirMatch = queryString.match(/(?:^|&)dir=([^&]*)/)
    if (dirMatch && dirMatch[1]) {
      directory = normalizeToForwardSlash(decodeDirectoryParam(dirMatch[1])) || undefined
    }
  }

  if (!directory) {
    const saved = serverStorage.get(STORAGE_KEY_LAST_DIRECTORY)
    if (saved) directory = saved
  }

  // 用 RegExp 构造,避开 regex literal 在源码里手写 / 转义容易出错
  const sessionMatch = path.match(new RegExp('^' + '#' + '/' + 'session' + '/' + '(.+)$'))
  if (sessionMatch) {
    return { sessionId: sessionMatch[1], directory, workbenchDirectory: undefined }
  }

  // 工作台独立路由: #/workbench 或 #/workbench?dir=...
  // 即使 URL 里没有 ?dir= 也要保留"在工作台"这件事,用 null 而不是 undefined
  if (path === '#/workbench' || path === 'workbench') {
    return { sessionId: null, directory, workbenchDirectory: directory ?? null }
  }

  return { sessionId: null, directory, workbenchDirectory: undefined }
}

export function buildHash(
  sessionId: string | null,
  directory: string | undefined,
  workbenchDirectory?: string | null | undefined,
): string {
  let path: string
  let dir: string | undefined
  if (workbenchDirectory !== undefined) {
    // 在工作台路由上 —— null 也算"在工作台",只是没选目录,所以 URL 不写 ?dir=
    path = '#/workbench'
    dir = workbenchDirectory ?? undefined
  } else if (sessionId) {
    path = '#/session/' + sessionId
    dir = directory
  } else {
    path = '#/'
    dir = directory
  }
  if (dir) {
    return path + '?dir=' + encodeURIComponent(dir)
  }
  return path
}

function isSameRoute(a: RouteState, b: RouteState): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.directory === b.directory &&
    a.workbenchDirectory === b.workbenchDirectory
  )
}

function ensureSnapshot(): RouteState {
  if (typeof window === 'undefined') {
    return { sessionId: null, directory: undefined, workbenchDirectory: undefined }
  }
  if (routeSnapshot === null) {
    routeSnapshot = parseHash()
  }
  return routeSnapshot
}

function emitRoute(next: RouteState) {
  const prev = ensureSnapshot()
  if (isSameRoute(prev, next)) return
  routeSnapshot = next
  for (const listener of listeners) listener()
}

function syncRouteFromHash() {
  emitRoute(parseHash())
}

function ensureWindowListener() {
  if (typeof window === 'undefined' || isListening) return
  routeSnapshot = parseHash()
  window.addEventListener('hashchange', syncRouteFromHash)
  isListening = true
}

function subscribe(listener: Listener): () => void {
  ensureWindowListener()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): RouteState {
  ensureWindowListener()
  return ensureSnapshot()
}

export function useRouter() {
  const route = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // 移动端用 replaceState 导航,避免浏览器历史栈堆积会话路由。
  // 手机浏览器左右滑动 = 前进/后退,历史栈里堆满会话会导致疯狂横跳。
  const isMobile = useIsMobile()
  const isMobileRef = useRef(isMobile)

  useEffect(() => {
    isMobileRef.current = isMobile
  }, [isMobile])

  const navigateToSession = useCallback((sessionId: string, directory?: string) => {
    const currentRoute = getSnapshot()
    const dir = directory !== undefined ? normalizeToForwardSlash(directory) || undefined : currentRoute.directory
    // 切到 session 路由 = 离开 workbench,清掉 workbench 标记
    const next: RouteState = { sessionId, directory: dir, workbenchDirectory: undefined }
    const newHash = buildHash(sessionId, dir, undefined)
    if (isMobileRef.current) {
      window.history.replaceState(null, '', newHash)
    } else {
      window.location.hash = newHash
    }
    emitRoute(next)
  }, [])

  const navigateHome = useCallback(() => {
    const currentRoute = getSnapshot()
    const next: RouteState = { sessionId: null, directory: currentRoute.directory, workbenchDirectory: undefined }
    const newHash = buildHash(null, currentRoute.directory, undefined)
    if (isMobileRef.current) {
      window.history.replaceState(null, '', newHash)
    } else {
      window.location.hash = newHash
    }
    emitRoute(next)
  }, [])

  // 进入工作台:directory 为 string → 在工作台且选了这个目录;undefined → 只换 view 不带目录。
  // 不带目录时 workbenchDirectory 用 null 标记,这样 App.tsx 的 isWorkbenchActive 仍然能识别。
  // 同时保留全局 directory 作为 fallback,让 WorkbenchPage 可以从 saved last directory 推断默认项目。
  const navigateToWorkbench = useCallback((directory?: string) => {
    const currentRoute = getSnapshot()
    const workbenchDir = directory ? normalizeToForwardSlash(directory) || null : null
    // 进入工作台不带目录时,保留当前全局 directory,WorkbenchPage 仍能用 last-saved 作为 fallback
    const nextDir = workbenchDir ?? currentRoute.directory ?? undefined
    const next: RouteState = { sessionId: null, directory: nextDir, workbenchDirectory: workbenchDir }
    const newHash = buildHash(null, nextDir, workbenchDir)
    if (isMobileRef.current) {
      window.history.replaceState(null, '', newHash)
    } else {
      window.location.hash = newHash
    }
    emitRoute(next)
  }, [])

  const replaceSession = useCallback((sessionId: string | null, directory?: string) => {
    const currentRoute = getSnapshot()
    const dir = directory !== undefined ? normalizeToForwardSlash(directory) || undefined : currentRoute.directory
    const newHash = buildHash(sessionId, dir)
    window.history.replaceState(null, '', newHash)
    emitRoute({ sessionId, directory: dir, workbenchDirectory: undefined })
  }, [])

  const setDirectory = useCallback((directory: string | undefined) => {
    const normalized = directory ? normalizeToForwardSlash(directory) : undefined
    const newHash = buildHash(null, normalized || undefined)
    const next: RouteState = { sessionId: null, directory: normalized || undefined, workbenchDirectory: undefined }
    if (normalized) {
      serverStorage.set(STORAGE_KEY_LAST_DIRECTORY, normalized)
    } else {
      serverStorage.remove(STORAGE_KEY_LAST_DIRECTORY)
    }
    window.location.hash = newHash
    emitRoute(next)
  }, [])

  const replaceDirectory = useCallback((directory: string | undefined) => {
    const currentRoute = getSnapshot()
    const normalized = directory ? normalizeToForwardSlash(directory) : undefined
    // 保留 workbench 标记 —— 如果之前在工作台,改全局 dir 不应该把人踢回仪表盘
    const next: RouteState = {
      sessionId: currentRoute.sessionId,
      directory: normalized || undefined,
      workbenchDirectory: currentRoute.workbenchDirectory,
    }
    const newHash = buildHash(currentRoute.sessionId, normalized || undefined, currentRoute.workbenchDirectory)
    if (normalized) {
      serverStorage.set(STORAGE_KEY_LAST_DIRECTORY, normalized)
    } else {
      serverStorage.remove(STORAGE_KEY_LAST_DIRECTORY)
    }
    window.history.replaceState(null, '', newHash)
    emitRoute(next)
  }, [])

  return {
    sessionId: route.sessionId,
    directory: route.directory,
    workbenchDirectory: route.workbenchDirectory,
    navigateToSession,
    navigateHome,
    navigateToWorkbench,
    replaceSession,
    setDirectory,
    replaceDirectory,
  }
}
