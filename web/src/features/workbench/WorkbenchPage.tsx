// TAPD 工作台页面：与仪表盘并列的独立首页入口（侧栏「工作台」进入）。
// 页面负责"看哪个项目"——默认取进入工作台时所处会话的目录，顶部选择器可切换；
// 任务/同步/绑定逻辑仍在 WorkbenchPanel 内。

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCurrentDirectory } from '../../contexts/useDirectory'
import { useSessionContext } from '../../contexts/useSessionContext'
import { normalizeToForwardSlash } from '../../utils'
import { getDirectoryName } from '../../utils'
import { WorkbenchPanel } from './WorkbenchPanel'

export interface WorkbenchPageProps {
  onOpenConfigSettings: () => void
  /** 进入工作台时所处会话的目录；优先作为默认项目 */
  initialDirectory?: string
}

/** 会话目录 + 当前目录去重排序，作为项目选择器的候选 */
function collectProjectDirectories(sessionDirs: (string | undefined)[], extra: (string | undefined)[]): string[] {
  const seen = new Map<string, string>()
  for (const dir of [...extra, ...sessionDirs]) {
    if (!dir) continue
    const normalized = normalizeToForwardSlash(dir)
    if (!normalized) continue
    // 大小写不同但指向同一目录（Windows）算一个
    const key = normalized.toLowerCase()
    if (!seen.has(key)) seen.set(key, normalized)
  }
  return [...seen.values()].sort((a, b) =>
    getDirectoryName(a).localeCompare(getDirectoryName(b), undefined, { sensitivity: 'base' }),
  )
}

export function WorkbenchPage({ onOpenConfigSettings, initialDirectory }: WorkbenchPageProps) {
  const { t } = useTranslation('workbench')
  const currentDirectory = useCurrentDirectory()
  const { sessions } = useSessionContext()

  // 默认项目：进入工作台时所在会话的目录 → 当前目录
  const defaultDirectory = useMemo(() => {
    const preferred = initialDirectory || currentDirectory
    return preferred ? normalizeToForwardSlash(preferred) : undefined
  }, [initialDirectory, currentDirectory])

  const [selected, setSelected] = useState<string | undefined>(defaultDirectory)

  // 从别的会话进工作台时默认项目会变——跟上，除非用户已手动切过
  const [userPicked, setUserPicked] = useState(false)
  useEffect(() => {
    if (userPicked) return
    setSelected(defaultDirectory)
  }, [defaultDirectory, userPicked])

  const candidates = useMemo(
    () => collectProjectDirectories(sessions.map(s => s.directory), [defaultDirectory, selected]),
    [sessions, defaultDirectory, selected],
  )

  const directory = selected ?? defaultDirectory

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        {directory ? (
          <WorkbenchPanel
            directory={directory}
            onOpenSettings={onOpenConfigSettings}
            projectCandidates={candidates}
            onSelectProject={dir => {
              setUserPicked(true)
              setSelected(dir)
            }}
          />
        ) : (
          // WorkbenchPanel 无目录时返回 null——作为独立页面必须给出说明，
          // 否则整页空白看不出原因
          <div className="rounded-xl bg-bg-100 border border-border-200/50 p-8 text-center">
            <div className="text-[length:var(--fs-base)] text-text-200">{t('noDirectoryTitle')}</div>
            <div className="mt-1 text-[length:var(--fs-sm)] text-text-400">{t('noDirectoryDescription')}</div>
          </div>
        )}
      </div>
    </div>
  )
}
