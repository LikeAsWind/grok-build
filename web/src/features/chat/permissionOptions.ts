/**
 * permissionOptions — ACP 权限选项的排序与样式归类
 *
 * 后端 prompter 按 AccessKind/client type 动态下发选项
 * （allow-once / always-allow / allow-always-command / reject-once / reject-always…），
 * UI 不写死按钮：按 kind 归类排序渲染，回包原样回显 optionId。
 */

import type { PermissionOptionInfo } from '../../types/api/permission'

/** 按钮视觉层级：主（允许一次）/ 次（总是允许）/ 弱（拒绝）/ 危险（总是拒绝） */
export type PermissionOptionTone = 'primary' | 'secondary' | 'muted' | 'danger'

const KIND_ORDER: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
}

/** 渲染顺序：允许一次 → 总是允许 → 拒绝 → 总是拒绝（同 kind 保持后端下发顺序） */
export function sortPermissionOptions(options: PermissionOptionInfo[]): PermissionOptionInfo[] {
  return [...options].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
}

export function permissionOptionTone(kind: string): PermissionOptionTone {
  switch (kind) {
    case 'allow_once':
      return 'primary'
    case 'allow_always':
      return 'secondary'
    case 'reject_always':
      return 'danger'
    default:
      return 'muted'
  }
}

/**
 * 选项文案本地化：后端下发的 name 是英文（"Yes, proceed" 等），
 * 按已知 kind 映射到 i18n 词条；动态命令选项（"Always allow: git push"）
 * 翻译前缀保留命令；未知 kind 回退后端原文。
 */
export function localizePermissionOptionName(
  opt: PermissionOptionInfo,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const dynamicCommand = /^Always allow:\s*(.+)$/i.exec(opt.name)
  if (dynamicCommand) return t('permissionDialog.options.alwaysAllowCommand', { command: dynamicCommand[1] })
  switch (opt.kind) {
    case 'allow_once':
      return t('permissionDialog.options.allowOnce')
    case 'allow_always':
      return t('permissionDialog.options.alwaysAllow')
    case 'reject_once':
      return t('permissionDialog.options.rejectOnce')
    case 'reject_always':
      return t('permissionDialog.options.rejectAlways')
    default:
      return opt.name || opt.id
  }
}
