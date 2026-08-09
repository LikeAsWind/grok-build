// ============================================
// SelectField - 主题化下拉选择（表单字段样式）
// 原生 <select> 的选项弹层不吃主题变量，统一用 DropdownMenu + MenuItem
// 模式对齐 AppearanceSettings 的语言选择器
// ============================================

import { useEffect, useRef, useState } from 'react'
import { DropdownMenu } from '../../../components/ui/DropdownMenu'
import { MenuItem } from '../../../components/ui/MenuItem'
import { ChevronDownIcon } from '../../../components/Icons'
import { settingsFieldClass } from './SettingsUI'

export interface SelectFieldOption {
  value: string
  label: string
}

export function SelectField({
  value,
  options,
  onChange,
  mono,
  className = '',
  ariaLabel,
}: {
  value: string
  options: SelectFieldOption[]
  onChange: (v: string) => void
  mono?: boolean
  /** 附加到触发按钮的类（如 !w-32 收窄） */
  className?: string
  ariaLabel?: string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const active = options.find(o => o.value === value)
  const displayLabel = active?.label ?? value

  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [isOpen])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onKeyDown={event => {
          if (event.key === 'Escape' && isOpen) {
            event.preventDefault()
            event.stopPropagation()
            setIsOpen(false)
          }
        }}
        className={`${settingsFieldClass} flex items-center justify-between gap-1.5 text-left cursor-pointer ${className}`}
      >
        <span className={`min-w-0 truncate ${mono ? 'font-mono' : ''} ${active || value ? '' : 'text-text-400'}`}>
          {displayLabel}
        </span>
        <ChevronDownIcon
          size={13}
          className={`shrink-0 text-text-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      <DropdownMenu triggerRef={triggerRef} isOpen={isOpen} position="bottom" align="left" minWidth="160px" zIndex={400}>
        <div ref={menuRef} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto custom-scrollbar">
          {options.map(option => (
            <MenuItem
              key={option.value}
              label={option.label}
              selected={option.value === value}
              selectionRole="option"
              onClick={() => {
                onChange(option.value)
                setIsOpen(false)
                triggerRef.current?.focus()
              }}
            />
          ))}
        </div>
      </DropdownMenu>
    </>
  )
}
