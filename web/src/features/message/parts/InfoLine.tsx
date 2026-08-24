import { memo, type ReactNode } from 'react'

/**
 * "一行逐项元信息"的共享展示组件——token 数 / cost / 耗时 / 完成时间这类小字
 * 信息，无论出现在 Step 完成信息（StepFinishPartView）还是压缩结果行
 * （CompactionPartView），都通过这一个组件渲染，保证字号/间距/颜色统一。
 * 调用方只负责拼出要显示哪些项，不用各自重写 flex 布局。
 */
export interface InfoLineItem {
  key: string
  content: ReactNode
  title?: string
  className?: string
}

export const INFO_LINE_CLASSNAME =
  'flex flex-wrap items-center gap-x-3 gap-y-0.5 py-0.5 text-[length:var(--fs-xxs)] leading-4 text-text-500'

export const InfoLine = memo(function InfoLine({
  items,
  className,
}: {
  items: InfoLineItem[]
  /** 追加在共享基础样式之后的额外类名（如压缩结果行需要 justify-center） */
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <div data-testid="info-line" className={className ? `${INFO_LINE_CLASSNAME} ${className}` : INFO_LINE_CLASSNAME}>
      {items.map(item => (
        <span key={item.key} className={item.className} title={item.title}>
          {item.content}
        </span>
      ))}
    </div>
  )
})
