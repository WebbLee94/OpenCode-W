import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatNumber } from '../lib/format'

interface PreviewTabPaginationProps {
  page: number
  total: number
  pageSize: number
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  pageSizeOptions?: readonly number[]
}

export default function PreviewTabPagination({
  page,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
}: PreviewTabPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (total === 0) return null
  const startIdx = (page - 1) * pageSize + 1
  const endIdx = Math.min(page * pageSize, total)

  return (
    <div className="shrink-0 flex items-center justify-between border-t border-gray-200 bg-white px-6 min-h-14">
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-500">
          显示 {startIdx}-{endIdx} / 共 {formatNumber(total)} 条
        </span>
        <div className="flex items-center gap-1.5 text-sm text-gray-500">
          <span>每页</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="appearance-none rounded border border-gray-300 bg-white px-2 py-0.5 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
          <span>条</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            max={totalPages}
            value={page}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (!isNaN(v)) onPageChange(Math.max(1, Math.min(totalPages, v)))
            }}
            className="w-14 rounded-md border border-gray-300 px-2 py-1 text-center text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <span className="text-sm text-gray-500">/ {totalPages}</span>
        </div>
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}
