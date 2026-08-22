// 会话侧栏视图切换按钮：列表视图 ↔ 文件夹视图。订阅 sessionHubViewStore，
// 点击切换 viewMode（持久化到 localStorage，见 sessionHubViewStore.ts）。

import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderIcon, ListIcon } from '../../components/Icons'
import { sessionHubViewStore } from '../../store/sessionHubViewStore'

export function ViewToggleButton() {
  const { t } = useTranslation('chat')
  const snapshot = useSyncExternalStore(sessionHubViewStore.subscribe, sessionHubViewStore.getSnapshot)
  const isFolder = snapshot.viewMode === 'folder'
  const label = isFolder ? t('sessionsHub.viewList') : t('sessionsHub.viewFolder')

  return (
    <button
      type="button"
      onClick={() => sessionHubViewStore.toggleViewMode()}
      className={`h-7 px-2 rounded-md text-[length:var(--fs-xs)] transition-colors flex items-center gap-1 ${
        isFolder ? 'text-accent-main-100' : 'text-text-400 hover:text-text-200'
      }`}
      title={label}
      aria-label={label}
    >
      {isFolder ? <ListIcon size={12} /> : <FolderIcon size={12} />}
    </button>
  )
}
