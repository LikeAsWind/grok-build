// 新建会话对话框：选择工作目录（最近列表 / 手动输入 / 浏览模态框），
// Git 仓库可选在隔离 worktree 中运行，创建成功后通知父组件。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { SpinnerIcon } from '../../components/Icons'
import { useDirectory } from '../../contexts/useDirectory'
import { useSessionContext } from '../../contexts/useSessionContext'
import { gitRootFor, createIsolatedWorktree, pagerWorktreeId } from '../../api/worktree'
import { subscribeWorktreeStatus, type WorktreeProgress } from './worktreeStatusStore'
import { DirBrowserModal } from '../chat/sidebar/DirBrowserModal'
import { DirectorySelector } from './DirectorySelector'

export interface NewSessionDialogProps {
  isOpen: boolean
  initialDirectory: string
  onClose: () => void
  onCreated: (session: { id: string; directory?: string }) => void
}

export function NewSessionDialog({ isOpen, initialDirectory, onClose, onCreated }: NewSessionDialogProps) {
  const { t } = useTranslation('chat')
  const { recentProjects, touchDirectory } = useDirectory()
  const { createSession } = useSessionContext()

  const [selectedDir, setSelectedDir] = useState(initialDirectory)
  const [isGit, setIsGit] = useState<boolean | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [worktreeProgress, setWorktreeProgress] = useState<WorktreeProgress | null>(null)
  const [creating, setCreating] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)

  // 打开 / 初始目录变化时重置状态并检测 git
  useEffect(() => {
    if (!isOpen) return
    setSelectedDir(initialDirectory)
    setUseWorktree(false)
    setWorktreeProgress(null)
    setIsGit(null)
    if (initialDirectory) {
      void gitRootFor(initialDirectory)
        .then(root => setIsGit(Boolean(root)))
        .catch(() => setIsGit(false))
    } else {
      setIsGit(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialDirectory])

  // 选中目录变化时若仍是初始目录则复用上面 effect 的结果；否则重新检测 git
  useEffect(() => {
    if (!isOpen) return
    if (selectedDir === initialDirectory) return
    if (!selectedDir) {
      setIsGit(false)
      return
    }
    let cancelled = false
    setIsGit(null)
    void gitRootFor(selectedDir)
      .then(root => {
        if (!cancelled) setIsGit(Boolean(root))
      })
      .catch(() => {
        if (!cancelled) setIsGit(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, selectedDir, initialDirectory])

  const handleCreate = async () => {
    if (!selectedDir || creating) return
    setCreating(true)
    setWorktreeProgress(null)
    try {
      let sessionDir = selectedDir
      if (useWorktree && isGit) {
        const worktreeId = pagerWorktreeId()
        const unsubscribe = subscribeWorktreeStatus(worktreeId, progress => {
          setWorktreeProgress(progress)
        })
        try {
          const created = await createIsolatedWorktree({
            sourcePath: selectedDir,
            worktreeId,
          })
          sessionDir = created.sessionCwd
        } catch (e) {
          setWorktreeProgress({
            kind: 'error',
            message: e instanceof Error ? e.message : String(e),
          })
          return
        } finally {
          unsubscribe()
        }
      }
      const session = await createSession(undefined, sessionDir)
      touchDirectory(sessionDir)
      onCreated(session)
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Dialog isOpen={isOpen} onClose={onClose} title={t('sessionsHub.newChatDialogTitle')} width={520}>
        <div className="space-y-4">
          <DirectorySelector
            recentProjects={recentProjects}
            selected={selectedDir}
            onSelect={setSelectedDir}
          />

          <button
            type="button"
            onClick={() => setBrowserOpen(true)}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-md border border-dashed border-border-200 text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:border-border-100 transition-colors"
          >
            {t('sessionsHub.browseFilesystem')}
          </button>

          {isGit && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                role="switch"
                checked={useWorktree}
                onChange={e => setUseWorktree(e.target.checked)}
                className="accent-accent-main-100"
              />
              <span className="text-[length:var(--fs-sm)] text-text-200">
                {t('sessionsHub.runInWorktree')}
              </span>
              <span className="text-[length:var(--fs-xs)] text-text-400">{t('sessionsHub.worktreeHint')}</span>
            </label>
          )}

          {creating && worktreeProgress?.kind === 'progress' && (
            <div className="flex items-center gap-2 text-[length:var(--fs-sm)] text-text-300">
              <SpinnerIcon size={14} className="animate-spin" />
              <span>{worktreeProgress.message ?? t('sessionsHub.creating')}</span>
            </div>
          )}

          {worktreeProgress?.kind === 'error' && (
            <div className="text-[length:var(--fs-sm)] text-danger-100">
              {worktreeProgress.message}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('sessionsHub.cancel')}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={!selectedDir || creating}>
              {creating ? t('sessionsHub.creating') : t('sessionsHub.createSession')}
            </Button>
          </div>
        </div>
      </Dialog>

      <DirBrowserModal
        isOpen={browserOpen}
        initialPath={selectedDir || initialDirectory}
        onSelect={path => {
          setSelectedDir(path)
          setBrowserOpen(false)
        }}
        onClose={() => setBrowserOpen(false)}
      />
    </>
  )
}