import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentProject } from '../api'
import { acpExtRequest } from '../api/acpBridge'
import { subscribeToEvents } from '../api/events'
import { serverStore } from '../store/serverStore'
import { getDirectoryName, normalizeToForwardSlash } from '../utils'

// worktree list 响应是 Vec<WorktreeRecord>（JSON 序列化），每条记录有 path 字段；
// 容忍兼容老格式的纯字符串数组；空/异常响应降级为 []
function extractWorktreePaths(resp: unknown): string[] {
  if (!Array.isArray(resp)) return []
  const out: string[] = []
  for (const item of resp) {
    if (typeof item === 'string' && item) {
      out.push(item)
    } else if (
      item &&
      typeof item === 'object' &&
      'path' in item &&
      typeof (item as { path: unknown }).path === 'string'
    ) {
      out.push((item as { path: string }).path)
    }
  }
  return out
}

export interface GitWorkspaceMeta {
  isGit: boolean
  rootDirectory: string
  // root workspace 放第一位，后面才是 sandbox worktree
  workspaces: string[]
}

export type GitWorkspaceCatalog = Map<string, GitWorkspaceMeta>

type RefreshListener = () => void

const refreshListeners = new Set<RefreshListener>()

export function requestGitWorkspaceCatalogRefresh() {
  refreshListeners.forEach(listener => listener())
}

export function useGitWorkspaceCatalog(directories: string[]) {
  const [catalog, setCatalog] = useState<GitWorkspaceCatalog>(new Map())
  const [isLoading, setIsLoading] = useState(false)
  const mountedRef = useRef(true)
  const versionRef = useRef(0)
  const catalogRef = useRef<GitWorkspaceCatalog>(new Map())

  const setCatalogState = useCallback((nextCatalog: GitWorkspaceCatalog) => {
    catalogRef.current = nextCatalog
    setCatalog(nextCatalog)
  }, [])

  const refresh = useCallback(async () => {
    const version = ++versionRef.current
    const normalizedDirectorySet = new Set(
      directories.filter(Boolean).map(directory => normalizeToForwardSlash(directory)),
    )
    const normalizedDirectories = Array.from(normalizedDirectorySet)

    if (normalizedDirectories.length === 0) {
      setIsLoading(false)
      setCatalogState(new Map())
      return
    }

    setIsLoading(true)
    const previousCatalog = catalogRef.current

    try {
      const projectResults = await Promise.allSettled(
        normalizedDirectories.map(async directory => ({
          directory,
          project: await getCurrentProject(directory),
        })),
      )

      if (!mountedRef.current || version !== versionRef.current) return

      const rootDirectories = new Set<string>()
      const directoryToRoot = new Map<string, string>()
      const nextCatalog: GitWorkspaceCatalog = new Map()
      const previousWorkspacesByRoot = new Map<string, string[]>()

      for (const [directory, meta] of previousCatalog) {
        if (meta.isGit) {
          previousWorkspacesByRoot.set(meta.rootDirectory, meta.workspaces)
        }

        if (normalizedDirectorySet.has(directory)) {
          nextCatalog.set(directory, meta)
        }
      }

      for (let index = 0; index < projectResults.length; index++) {
        const result = projectResults[index]
        const directory = normalizedDirectories[index]

        if (result.status !== 'fulfilled') {
          const previousMeta = previousCatalog.get(directory)
          if (previousMeta?.isGit) {
            rootDirectories.add(previousMeta.rootDirectory)
            directoryToRoot.set(directory, previousMeta.rootDirectory)
          }
          continue
        }

        const { project } = result.value

        // getCurrentProject() 依赖已被 stub 的 SDK，可能返回不完整对象——安全检查
        if (project && project.vcs === 'git' && project.worktree) {
          const rootDirectory = normalizeToForwardSlash(project.worktree)
          rootDirectories.add(rootDirectory)
          directoryToRoot.set(directory, rootDirectory)
        } else {
          nextCatalog.set(directory, {
            isGit: false,
            rootDirectory: directory,
            workspaces: [directory],
          })
        }
      }

      const rootDirectoryList = Array.from(rootDirectories)

      const workspaceResults = await Promise.allSettled(
        rootDirectoryList.map(async rootDirectory => {
          const repo = getDirectoryName(rootDirectory)
          const resp = await acpExtRequest('x.ai/git/worktree/list', { repo })
          return { rootDirectory, worktrees: extractWorktreePaths(resp) }
        }),
      )

      if (!mountedRef.current || version !== versionRef.current) return

      const rootToWorkspaces = new Map<string, string[]>()

      for (let index = 0; index < workspaceResults.length; index++) {
        const result = workspaceResults[index]
        const rootDirectory = rootDirectoryList[index]

        if (result.status !== 'fulfilled') {
          rootToWorkspaces.set(rootDirectory, previousWorkspacesByRoot.get(rootDirectory) ?? [rootDirectory])
          continue
        }

        const { worktrees } = result.value
        const normalizedWorktrees = Array.from(new Set(worktrees.map(worktree => normalizeToForwardSlash(worktree))))
        const sandboxes = normalizedWorktrees.filter(worktree => worktree.toLowerCase() !== rootDirectory.toLowerCase())
        rootToWorkspaces.set(rootDirectory, [rootDirectory, ...sandboxes])
      }

      for (const [directory, rootDirectory] of directoryToRoot) {
        nextCatalog.set(directory, {
          isGit: true,
          rootDirectory,
          workspaces: rootToWorkspaces.get(rootDirectory) ?? [rootDirectory],
        })
      }

      setCatalogState(nextCatalog)
    } finally {
      if (mountedRef.current && version === versionRef.current) {
        setIsLoading(false)
      }
    }
  }, [directories, setCatalogState])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  useEffect(() => {
    return subscribeToEvents({
      onWorktreeReady: () => void refresh(),
      onWorktreeFailed: () => void refresh(),
      onReconnected: reason => {
        if (reason !== 'server-switch') void refresh()
      },
    })
  }, [refresh])

  useEffect(() => {
    const listener = () => void refresh()
    refreshListeners.add(listener)
    return () => {
      refreshListeners.delete(listener)
    }
  }, [refresh])

  useEffect(() => {
    return serverStore.onServerChange(() => void refresh())
  }, [refresh])

  return {
    catalog,
    isLoading,
    refresh,
  }
}
