// 目录浏览器模态框 — 浏览后端本地文件系统，选择工作目录

import { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { FolderIcon, FileIcon, ChevronRightIcon, RetryIcon } from '../../../components/Icons'
import { browseDirectory, type BrowseDirEntry } from '../../../api/grokConfig'

interface DirBrowserModalProps {
  isOpen: boolean
  initialPath: string
  onSelect: (path: string) => void
  onClose: () => void
}

export function DirBrowserModal({ isOpen, initialPath, onSelect, onClose }: DirBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState(initialPath)
  const [entries, setEntries] = useState<BrowseDirEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [inputPath, setInputPath] = useState(initialPath)

  const loadDir = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await browseDirectory(path || '')
      setCurrentPath(result.path)
      setEntries(result.entries)
      setInputPath(result.path)
      if (result.error) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) loadDir(initialPath)
  }, [isOpen, initialPath, loadDir])

  const goUp = () => {
    let parent = currentPath.replace(/[/\\]+$/, '')
    // Windows 盘符根目录 (C:\) → 返回空触发展示盘符列表
    if (/^[a-zA-Z]:$/.test(parent)) { loadDir(''); return }
    parent = parent.replace(/[/\\][^/\\]+$/, '') || ''
    loadDir(parent)
  }

  const goInto = (name: string) => {
    // 盘符列表 (空 path) → 直接拼 C:\
    const sep = !currentPath || currentPath.endsWith('/') || currentPath.endsWith('\\') ? '' : '\\'
    loadDir(currentPath + sep + name)
  }

  const handlePathSubmit = () => {
    const p = inputPath.trim()
    if (p) loadDir(p)
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="选择工作目录" width={560}>
      <div className="space-y-2.5">
        {/* 路径输入栏 */}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={inputPath}
            onChange={e => setInputPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handlePathSubmit() }}
            placeholder="输入路径，回车浏览"
            spellCheck={false}
            className="flex-1 h-8 px-2.5 text-[length:var(--fs-sm)] font-mono rounded-md bg-transparent text-text-100 border border-border-200 outline-none focus:border-accent-main-100"
          />
          <Button variant="ghost" size="sm" onClick={goUp} disabled={!currentPath} title="上级目录">
            ..
          </Button>
          <Button variant="ghost" size="sm" onClick={() => loadDir(currentPath)} disabled={loading} title="刷新">
            <RetryIcon size={14} />
          </Button>
        </div>

        {/* 目录列表 */}
        <div className="rounded-lg border border-border-200/60 overflow-hidden">
          <div className="max-h-72 overflow-y-auto overflow-x-hidden custom-scrollbar">
            {loading ? (
              <div className="py-8 text-center text-[length:var(--fs-sm)] text-text-400">加载中…</div>
            ) : error && entries.length === 0 ? (
              <div className="py-8 text-center text-[length:var(--fs-sm)] text-text-400">
                <p className="text-danger-100">{error}</p>
              </div>
            ) : entries.length === 0 ? (
              <div className="py-8 text-center text-[length:var(--fs-sm)] text-text-400">空目录</div>
            ) : (
              entries.map((entry, i) => (
                <button
                  key={`${entry.name}-${i}`}
                  type="button"
                  onClick={() => entry.isDir ? goInto(entry.name) : undefined}
                  disabled={!entry.isDir}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors min-w-0 ${
                    entry.isDir
                      ? 'hover:bg-bg-200/60 cursor-pointer text-text-200'
                      : 'text-text-500 cursor-default'
                  }`}
                >
                  {entry.isDir ? (
                    <FolderIcon size={14} className="shrink-0 text-text-400" />
                  ) : (
                    <FileIcon size={14} className="shrink-0 text-text-500" />
                  )}
                  <span className={`truncate text-[length:var(--fs-sm)] ${entry.isDir ? 'font-medium' : ''}`}>
                    {entry.name}
                  </span>
                  {entry.isDir && (
                    <ChevronRightIcon size={12} className="ml-auto shrink-0 text-text-500" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center justify-between pt-1">
          <div className="text-[length:var(--fs-xs)] text-text-400 font-mono truncate max-w-[280px]" title={currentPath}>
            {currentPath || '(根目录)'}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={() => { onSelect(currentPath); onClose() }} disabled={!currentPath}>
              选择此目录
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
