// 配置当前目录的 TAPD 绑定：Workspace ID（支持粘贴 TAPD 链接自动解析）+
// 模块筛选。写入走 patchGrokConfig（config.toml 的 PATCH 端点），与设置面板
// TAPD 分组同一套持久化机制。
//
// 未显式绑定的目录会继承 [tapd].default_workspace_id，模块默认取目录名小写；
// 这个对话框既用于"首次配置"，也用于"修改已生效的值"——打开时用当前生效的
// 绑定预填，用户改完保存即写成该目录的显式条目。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../components/ui/Dialog'
import { Button } from '../../components/ui/Button'
import { patchGrokConfig } from '../../api/grokConfig'
import type { TapdBinding } from '../../api/tapd'
import {
  buildBindingPatchOps,
  defaultModuleForDirectory,
  parseModuleFilter,
  parseWorkspaceIdFromTapdUrl,
} from './tapdBinding'

export interface BindProjectDialogProps {
  isOpen: boolean
  directory: string
  /** 当前生效的绑定（显式或继承），用于预填 */
  binding?: TapdBinding
  onClose: () => void
  onBound: () => void
}

export function BindProjectDialog({ isOpen, directory, binding, onClose, onBound }: BindProjectDialogProps) {
  const { t } = useTranslation('workbench')
  const [workspaceInput, setWorkspaceInput] = useState('')
  const [moduleFilter, setModuleFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 每次打开都按当前生效值重置——继承来的默认值也要显示出来，
  // 否则用户看不到"现在实际用的是什么"就得盲填
  useEffect(() => {
    if (!isOpen) return
    setWorkspaceInput(binding?.workspaceId ?? '')
    const modules = binding?.moduleFilter?.length
      ? binding.moduleFilter
      : [defaultModuleForDirectory(directory)].filter((m): m is string => !!m)
    setModuleFilter(modules.join(', '))
    setError('')
  }, [isOpen, binding, directory])

  const handleSubmit = async () => {
    const workspaceId = parseWorkspaceIdFromTapdUrl(workspaceInput)
    if (!workspaceId) {
      setError(t('workspaceIdInvalid'))
      return
    }
    setSaving(true)
    setError('')
    try {
      await patchGrokConfig({ set: buildBindingPatchOps({ directory, workspaceId, modules: parseModuleFilter(moduleFilter) }) })
      onBound()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('bindDialogTitle')} width={460}>
      <div className="space-y-3">
        <p className="text-[length:var(--fs-sm)] text-text-400">{t('bindDesc')}</p>

        <div>
          <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('workspaceId')}</label>
          <input
            type="text"
            value={workspaceInput}
            onChange={e => setWorkspaceInput(e.target.value)}
            placeholder={t('workspaceIdPlaceholder')}
            spellCheck={false}
            className="w-full h-8 px-2.5 text-[length:var(--fs-sm)] font-mono rounded-md bg-transparent text-text-100 border border-border-200 outline-none focus:border-accent-main-100"
            autoFocus
          />
          <p className="mt-1 text-[length:var(--fs-xxs)] text-text-500">{t('workspaceIdHint')}</p>
        </div>

        <div>
          <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('moduleFilter')}</label>
          <input
            type="text"
            value={moduleFilter}
            onChange={e => setModuleFilter(e.target.value)}
            placeholder={t('modulePlaceholder')}
            className="w-full h-8 px-2.5 text-[length:var(--fs-sm)] rounded-md bg-transparent text-text-100 border border-border-200 outline-none focus:border-accent-main-100"
          />
          <p className="mt-1 text-[length:var(--fs-xxs)] text-text-500">{t('moduleHint')}</p>
        </div>

        {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} disabled={saving}>
            {t('confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
