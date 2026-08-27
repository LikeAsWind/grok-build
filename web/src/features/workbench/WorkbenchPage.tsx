// TAPD 工作台页面:独立路由 #/workbench?dir=... 下的视图。
// 顶部工作目录选择/筛选组件永远可见(不管当前是否已选),符合"先选再加载"语义;
// 未选时下方的 WorkbenchPanel 退化成空任务框(提示"选个任务查看")——
// 不再额外塞一张"请选择工作目录"提示卡片。

import { useMemo } from 'react'
import { useCurrentDirectory } from '../../contexts/useDirectory'
import { useSessionContext } from '../../contexts/useSessionContext'
import { useRouter } from '../../hooks/useRouter'
import { normalizeToForwardSlash } from '../../utils'
import { getDirectoryName } from '../../utils'
import { WorkbenchPanel } from './WorkbenchPanel'
import { WorkbenchProjectSelector } from './WorkbenchProjectSelector'

export interface WorkbenchPageProps {
  onOpenConfigSettings: () => void
  /** 初始目录(从 URL hash 读),用于 server-side 渲染或首次挂载时预填。null 与 undefined 同样视为"还没选" */
  initialDirectory?: string | null
}

/** 会话目录 + 当前目录去重排序,作为项目选择器的候选 */
function collectProjectDirectories(sessionDirs: (string | undefined)[], extra: (string | undefined)[]): string[] {
  const seen = new Map<string, string>()
  for (const dir of [...extra, ...sessionDirs]) {
    if (!dir) continue
    const normalized = normalizeToForwardSlash(dir)
    if (!normalized) continue
    // 大小写不同但指向同一目录(Windows)算一个
    const key = normalized.toLowerCase()
    if (!seen.has(key)) seen.set(key, normalized)
  }
  return [...seen.values()].sort((a, b) =>
    getDirectoryName(a).localeCompare(getDirectoryName(b), undefined, { sensitivity: 'base' }),
  )
}

export function WorkbenchPage({ onOpenConfigSettings, initialDirectory }: WorkbenchPageProps) {
  const currentDirectory = useCurrentDirectory()
  const { sessions } = useSessionContext()
  const router = useRouter()

  // URL 路由状态:workbenchDirectory 存在 = 这次是 workbench 视图(独立 URI)
  const urlDirectory = router.workbenchDirectory

  // 默认项目:URL > initialDirectory > 当前目录
  const defaultDirectory = useMemo(() => {
    const preferred = urlDirectory || initialDirectory || currentDirectory
    return preferred ? normalizeToForwardSlash(preferred) : undefined
  }, [urlDirectory, initialDirectory, currentDirectory])

  // 写回 URL:独立 hash,这样 workbench 视图能收藏 / 刷新恢复
  const handleSelect = (dir: string) => {
    router.navigateToWorkbench(dir)
  }

  // 实际选中 = URL > default
  const directory = urlDirectory || defaultDirectory

  const candidates = useMemo(
    () => collectProjectDirectories(sessions.map(s => s.directory), [directory]),
    [sessions, directory],
  )

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        <div className="rounded-xl bg-bg-100 border border-border-200/50 p-4">
          <WorkbenchProjectSelector
            directory={directory}
            candidates={candidates}
            onSelect={handleSelect}
          />
        </div>
        <WorkbenchPanel
          directory={directory}
          onOpenSettings={onOpenConfigSettings}
        />
      </div>
    </div>
  )
}
