import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PreviewTabPaginationProps {
  page: number
  total: number
  pageSize: number
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
}

const OPTIONS = [10, 20, 50, 100] as const

export default function PreviewTabPagination({ page, total, pageSize, onPageChange, onPageSizeChange }: PreviewTabPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (total === 0) return null
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t bg-white shrink-0 text-xs text-gray-500">
      <button onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1} className="disabled:opacity-30 hover:text-gray-700">
        <ChevronLeft size={14} />
      </button>
      <div className="flex items-center gap-2">
        <select value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))} className="border rounded px-1.5 py-0.5 text-xs">
          {OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span>{page}/{totalPages} · {total} 条</span>
      </div>
      <button onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className="disabled:opacity-30 hover:text-gray-700">
        <ChevronRight size={14} />
      </button>
    </div>
  )
}
