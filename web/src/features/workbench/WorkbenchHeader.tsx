// 工作台头部:分支 + Workspace 指示 + 手动同步 + 绑定配置入口。
// 项目名在 WorkbenchPage 顶部那个选择器卡片里显示了,这里不再重复 ——
// 否则外面"my-project"、里面又"my-project",看着重复。

import { useTranslation } from 'react-i18next'
import { RetryIcon, SpinnerIcon } from '../../components/Icons'
import { Button } from '../../components/ui/Button'
import { useVcsInfo } from '../../hooks/useVcsInfo'
import type { TapdBinding } from '../../api/tapd'

export interface WorkbenchHeaderProps {
  /** 当前生效的目录。用于查分支(useVcsInfo),不展示名字 —— 名字由顶部选择器负责 */
  directory: string
  syncing: boolean
  onSyncNow: () => void
  onOpenSettings: () => void
  /** 当前生效的绑定,用于显示 workspace 与"继承默认"提示 */
  binding?: TapdBinding
  onEditBinding: () => void
}

export function WorkbenchHeader({
  directory,
  syncing,
  onSyncNow,
  onOpenSettings,
  binding,
  onEditBinding,
}: WorkbenchHeaderProps) {
  const { t } = useTranslation('workbench')
  const { vcsInfo } = useVcsInfo(directory)

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {vcsInfo?.branch && (
            <span className="text-[length:var(--fs-sm)] text-text-400 shrink-0 font-mono">{vcsInfo.branch}</span>
          )}
          {syncing && (
            <span className="flex items-center gap-1 text-[length:var(--fs-xs)] text-accent-main-100 shrink-0">
              <SpinnerIcon size={12} className="animate-spin" />
              {t('syncing')}
            </span>
          )}
        </div>
        {binding && (
          <div className="mt-0.5 flex items-center gap-2 text-[length:var(--fs-xxs)] text-text-500">
            <span className="font-mono">#{binding.workspaceId}</span>
            {binding.moduleFilter.length > 0 && (
              <span className="truncate">{t('module')}: {binding.moduleFilter.join(', ')}</span>
            )}
            {/* 继承默认值时明确标出来,否则用户以为这里已经单独配过 */}
            {!binding.explicit && <span className="shrink-0 opacity-70">({t('inheritedBinding')})</span>}
          </div>
        )}
      </div>

      <Button variant="ghost" size="sm" onClick={onSyncNow} disabled={syncing}>
        <RetryIcon size={13} className={syncing ? 'animate-spin' : ''} />
        {t('syncNow')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onEditBinding}>
        {t('editBinding')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onOpenSettings}>
        {t('settings')}
      </Button>
    </div>
  )
}
