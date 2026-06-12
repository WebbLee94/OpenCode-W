import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface PartBubbleShellProps {
  icon: string
  title: ReactNode
  status?: ReactNode
  meta?: ReactNode
  variant?: 'neutral' | 'action' | 'attach' | 'change' | 'event'
  children?: ReactNode
  collapsible?: boolean
  defaultExpanded?: boolean
}

const VARIANT_STYLES = {
  neutral: 'border-gray-200 bg-gray-50/50',
  action: 'border-orange-200 bg-orange-50/30',
  attach: 'border-blue-200 bg-blue-50/30',
  change: 'border-purple-200 bg-purple-50/30',
  event: 'border-yellow-200 bg-yellow-50/30',
} as const

export default function PartBubbleShell({
  icon,
  title,
  status,
  meta,
  variant = 'neutral',
  children,
  collapsible = true,
  defaultExpanded = true,
}: PartBubbleShellProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasExpandableContent = collapsible && Boolean(children)

  return (
    <div className={`rounded-lg border p-2.5 text-sm min-w-0 max-w-full overflow-hidden ${VARIANT_STYLES[variant]}`}>
      <div className="flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-800 truncate">{title}</div>
          {meta && <div className="text-xs text-gray-500 mt-0.5">{meta}</div>}
        </div>
        {status && <div className="shrink-0">{status}</div>}
        {hasExpandableContent && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-gray-400 hover:text-gray-600 shrink-0"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
      </div>
      {expanded && children && <div className="mt-2">{children}</div>}
    </div>
  )
}
