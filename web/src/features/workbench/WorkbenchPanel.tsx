// TAPD 工作台面板:按当前目录展示其 TAPD 项目视图。
// - 未选目录:只渲染空任务框,提示"选个任务查看"
// - 已选目录:渲染 header(项目名 + 分支 + 同步/编辑/设置按钮) + overview + 任务列表 + 同步历史
// - 顶部项目选择器在 WorkbenchPage 那一层(永远可见),这里不再放选择器避免重复

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { useTapdWorkbench } from './useTapdWorkbench'
import { WorkbenchHeader } from './WorkbenchHeader'
import { WorkbenchOverview } from './WorkbenchOverview'
import { WorkbenchTaskList } from './WorkbenchTaskList'
import { SyncHistoryPanel } from './SyncHistoryPanel'
import { TaskDetailDrawer } from './TaskDetailDrawer'
import { BindProjectDialog } from './BindProjectDialog'
import { ChevronDownIcon } from '../../components/Icons'
import type { TapdTask } from '../../api/tapd'

export interface WorkbenchPanelProps {
  directory: string | undefined
  onOpenSettings: () => void
}

export function WorkbenchPanel({ directory, onOpenSettings }: WorkbenchPanelProps) {
  const { t } = useTranslation('workbench')
  const { status, loading, syncing, triggerSync, refresh } = useTapdWorkbench(directory)
  const [bindOpen, setBindOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<TapdTask | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const handleSyncNow = useCallback(() => {
    void triggerSync()
  }, [triggerSync])

  // 同步完成(syncing 从 true → false)时任务列表也要跟着刷新一次。
  const wasSyncingRef = useRef(syncing)
  useEffect(() => {
    if (wasSyncingRef.current && !syncing) setRefreshToken(v => v + 1)
    wasSyncingRef.current = syncing
  }, [syncing])

  // 未选目录:任务框本身保持可见,空态提示"选个任务查看"。
  // 不渲染 header / overview / 同步历史 —— 都没对应数据。
  if (!directory) {
    return (
      <div className="rounded-xl bg-bg-100 border border-border-200/50 p-4 flex flex-col gap-3">
        <div className="border-t border-border-200/50 pt-3 flex-1 min-h-0">
          <WorkbenchTaskList
            directory={undefined}
            modules={[]}
            onOpenTask={setSelectedTask}
            refreshToken={refreshToken}
          />
        </div>
        <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTask(null)} />
      </div>
    )
  }

  if (loading && !status) {
    return (
      <div className="rounded-xl bg-bg-100 border border-border-200/50 p-5 flex items-center justify-center h-32">
        <span className="w-4 h-4 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (!status?.bound) {
    return (
      <div className="rounded-xl bg-bg-100 border border-border-200/50 p-4 flex items-center justify-between gap-3">
        <span className="text-[length:var(--fs-sm)] text-text-400">{t('bindPrompt')}</span>
        <Button size="sm" onClick={() => setBindOpen(true)}>
          {t('bindProject')}
        </Button>
        <BindProjectDialog
          isOpen={bindOpen}
          directory={directory}
          binding={status?.binding}
          onClose={() => setBindOpen(false)}
          onBound={refresh}
        />
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-bg-100 border border-border-200/50 p-4 flex flex-col gap-3">
      <WorkbenchHeader
        directory={directory}
        syncing={syncing}
        onSyncNow={handleSyncNow}
        onOpenSettings={onOpenSettings}
        binding={status.binding}
        onEditBinding={() => setBindOpen(true)}
      />

      <div className="border-t border-border-200/50 pt-3">
        <WorkbenchOverview counts={status.counts} cursor={status.cursor} />
      </div>

      {status.cursor?.lastSyncStatus === 'failed' && status.cursor.lastSyncError && (
        <div className="p-2 rounded-md bg-danger-100/10 border border-danger-100/20 text-[length:var(--fs-xs)] text-danger-100">
          {t('errorTitle')}: {status.cursor.lastSyncError}
        </div>
      )}

      <div className="border-t border-border-200/50 pt-3 flex-1 min-h-0">
        <WorkbenchTaskList
          directory={directory}
          modules={status.modules}
          onOpenTask={setSelectedTask}
          refreshToken={refreshToken}
        />
      </div>

      <div className="border-t border-border-200/50 pt-2">
        <button
          type="button"
          onClick={() => setHistoryOpen(v => !v)}
          className="flex items-center gap-1 text-[length:var(--fs-xs)] text-text-400 hover:text-text-200 transition-colors"
        >
          <span className={`transition-transform ${historyOpen ? 'rotate-180' : ''}`}>
            <ChevronDownIcon size={12} />
          </span>
          {t('syncHistory')}
        </button>
        {historyOpen && (
          <div className="mt-2">
            <SyncHistoryPanel runs={status.recentRuns} />
          </div>
        )}
      </div>

      <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTask(null)} />

      {/* 已绑定态也要能改配置——「配置」按钮打开同一个对话框 */}
      <BindProjectDialog
        isOpen={bindOpen}
        directory={directory}
        binding={status.binding}
        onClose={() => setBindOpen(false)}
        onBound={refresh}
      />
    </div>
  )
}
