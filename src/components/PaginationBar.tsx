import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatNumber } from '../lib/format'

interface PaginationBarProps {
  page: number
  total: number
  pageSize: number
  pageSizeOptions?: readonly number[]
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  sticky?: boolean
  position?: 'bottom' | 'inline'
}

export default function PaginationBar({
  page,
  total,
  pageSize,
  pageSizeOptions = [10, 20, 50],
  onPageChange,
  onPageSizeChange,
  sticky = true,
  position = 'bottom',
}: PaginationBarProps) {
  if (total === 0) return null
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const containerClass = position === 'bottom' && sticky
    ? 'sticky bottom-0 z-10 border-t border-gray-200 bg-white px-4 py-2.5 flex items-center justify-between text-xs text-gray-500'
    : 'border-t border-gray-200 bg-white px-4 py-2.5 flex items-center justify-between text-xs text-gray-500'

  return (
    <div className={containerClass}>
      <button
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="disabled:opacity-30 hover:text-gray-700"
        aria-label="上一页"
      >
        <ChevronLeft size={16} />
      </button>
      <div className="flex items-center gap-2">
        <select
          value={pageSize}
          onChange={e => onPageSizeChange(Number(e.target.value))}
          className="appearance-none rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {pageSizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span>{page}/{totalPages} · 共 {formatNumber(total)} 条</span>
      </div>
      <button
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="disabled:opacity-30 hover:text-gray-700"
        aria-label="下一页"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}
