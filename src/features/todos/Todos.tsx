import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import type { TodoDTO, TodoFilter } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatNumber, truncateText } from '../../lib/format'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  ClipboardList,
  MessageSquare,
} from 'lucide-react'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待处理' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
] as const

const PRIORITY_OPTIONS = [
  { value: '', label: '全部优先级' },
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
] as const

// ─── Status Badge ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    pending: { label: '⏳ 待处理', className: 'bg-gray-100 text-gray-700' },
    in_progress: { label: '🔄 进行中', className: 'bg-blue-100 text-blue-700' },
    completed: { label: '✅ 完成', className: 'bg-green-100 text-green-700' },
    cancelled: { label: '🚫 取消', className: 'bg-red-100 text-red-700' },
  }
  const c = config[status] ?? { label: status, className: 'bg-gray-100 text-gray-700' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  )
}

// ─── Priority Badge ─────────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority: string }) {
  const config: Record<string, { label: string; className: string }> = {
    high: { label: '🔴 高', className: 'bg-red-100 text-red-700' },
    medium: { label: '🟡 中', className: 'bg-yellow-100 text-yellow-700' },
    low: { label: '🟢 低', className: 'bg-green-100 text-green-700' },
  }
  const c = config[priority] ?? { label: priority, className: 'bg-gray-100 text-gray-700' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  )
}

// ─── Todos Page ──────────────────────────────────────────────────────────────

function Todos() {
  const [todos, setTodos] = useState<TodoDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  // Filter state
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState('')
  const [priority, setPriority] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(DEFAULT_PAGE_SIZE)

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navigate = useNavigate()

  // ─── Debounced search ──────────────────────────────────────────────────

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value)
      setPage(1)
    }, 300)
  }, [])

  // ─── Load todos ───────────────────────────────────────────────────────

  useEffect(() => {
    const filter: TodoFilter = {
      search: debouncedSearch || undefined,
      status: status || undefined,
      priority: priority || undefined,
      page,
      pageSize,
    }

    setLoading(true)
    invokeSafe<{ data: TodoDTO[]; total: number; page: number; pageSize: number }>(IPC_CHANNELS.TODOS_LIST, filter)
      .then((result) => {
        setTodos(result.data)
        setTotal(result.total)
      })
      .catch(() => {
        setTodos([])
        setTotal(0)
      })
      .finally(() => setLoading(false))
  }, [debouncedSearch, status, priority, page, pageSize])

  // ─── Pagination helpers ──────────────────────────────────────────────

  const totalPages = Math.ceil(total / pageSize)
  const startIdx = (page - 1) * pageSize + 1
  const endIdx = Math.min(page * pageSize, total)

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* Header & Filters */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList size={24} className="text-brand-600" />
            <h2 className="text-2xl font-semibold text-gray-900">待办管理</h2>
          </div>
          <span className="text-sm text-gray-500">共 {formatNumber(total)} 条待办</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索待办内容..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {search && (
              <button
                onClick={() => handleSearchChange('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Status filter */}
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
            className="min-w-[120px] appearance-none rounded-md border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Priority filter */}
          <select
            value={priority}
            onChange={(e) => { setPriority(e.target.value); setPage(1) }}
            className="min-w-[120px] appearance-none rounded-md border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-0">
        {loading && todos.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">加载中...</div>
        ) : todos.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">暂无待办数据</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="w-12 px-4 py-3 text-center font-medium text-gray-500">#</th>
                <th className="py-3 pr-4 text-left font-medium text-gray-500">待办内容</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">优先级</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">所属会话</th>
              </tr>
            </thead>
            <tbody>
              {todos.map((todo, idx) => (
                <tr
                  key={`${todo.session_id}-${todo.position}`}
                  className={`cursor-pointer border-b border-gray-100 transition-colors hover:bg-brand-50 ${
                    idx % 2 === 1 ? 'bg-gray-50/50' : ''
                  }`}
                  onClick={() => navigate(`/sessions/${todo.session_id}/messages`)}
                >
                  <td className="px-4 py-3 text-center text-gray-400 text-xs">{(page - 1) * pageSize + idx + 1}</td>
                  <td className="max-w-xs py-3 pr-4 text-gray-900" title={todo.content}>
                    {truncateText(todo.content, 120)}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={todo.status} /></td>
                  <td className="px-4 py-3"><PriorityBadge priority={todo.priority} /></td>
                  <td className="max-w-[200px] truncate px-4 py-3">
                    <span
                      className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-800 transition-colors"
                      title={todo.session_title}
                    >
                      <MessageSquare size={12} />
                      {truncateText(todo.session_title, 30)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="shrink-0 flex items-center justify-between border-t border-gray-200 bg-white px-6 py-3">
          <span className="text-sm text-gray-500">
            显示 {startIdx}-{endIdx} / 共 {formatNumber(total)} 条
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm text-gray-500">{page} / {totalPages || 1}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default Todos
