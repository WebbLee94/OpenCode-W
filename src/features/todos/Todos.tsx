import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router'
import type { TodoDTO, TodoFilter } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatNumber, truncateText } from '../../lib/format'
import PageHeader from '../../components/PageHeader'
import PaginationBar from '../../components/PaginationBar'
import {
  Search,
  X,
  ChevronRight,
  ClipboardList,
  MessageSquare,
  FolderOpen,
} from 'lucide-react'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

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

// ─── Display Maps ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

const PRIORITY_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
  in_progress: 'bg-blue-100 text-blue-700',
  pending: 'bg-yellow-100 text-yellow-700',
}

const PRIORITY_BADGE: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
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
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<string[]>([])
  const [projectSearch, setProjectSearch] = useState('')
  const [projectOpen, setProjectOpen] = useState(false)
  const projectRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (projectRef.current && !projectRef.current.contains(e.target as Node)) setProjectOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const sortedProjects = useMemo(() =>
    projects.filter(p => !projectSearch || p.toLowerCase().includes(projectSearch.toLowerCase()))
      .sort((a, b) => (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b))
  , [projects, projectSearch])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(() => {
    const saved = localStorage.getItem('dbscope-todos-page-size')
    return saved ? parseInt(saved, 10) : DEFAULT_PAGE_SIZE
  })

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

  // ─── Load projects list ─────────────────────────────────────────────

  useEffect(() => {
    invokeSafe<string[]>(IPC_CHANNELS.SESSIONS_PROJECTS)
      .then((result) => setProjects(result))
      .catch(() => setProjects([]))
  }, [])

  // ─── Load todos ───────────────────────────────────────────────────────

  useEffect(() => {
    const filter: TodoFilter = {
      search: debouncedSearch || undefined,
      status: status || undefined,
      priority: priority || undefined,
      projectId: projectId || undefined,
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
  }, [debouncedSearch, status, priority, projectId, page, pageSize])

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* Header & Filters */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-4">
        <PageHeader
          icon={<ClipboardList size={24} />}
          title="待办管理"
          right={<span className="text-sm text-gray-500">共 {formatNumber(total)} 条待办</span>}
        />

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

          {/* Project filter with search */}
          <div className="relative min-w-[180px]" ref={projectRef}>
            <FolderOpen size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <button
              onClick={() => setProjectOpen(!projectOpen)}
              className="w-full appearance-none rounded-md border border-gray-300 bg-white py-2 pl-9 pr-8 text-sm text-gray-900 text-left truncate focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              {projectId ? projectId.split('/').pop() || projectId : '全部项目'}
            </button>
            <ChevronRight size={14} className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 transition-transform ${projectOpen ? 'rotate-90' : 'rotate-0'}`} />
            {projectOpen && (
              <div className="absolute z-30 top-full left-0 mt-1 w-80 bg-white border border-gray-200 rounded shadow-lg max-h-64 overflow-hidden">
                <div className="p-2 border-b">
                  <input type="text" placeholder="搜索项目..." value={projectSearch}
                    onChange={e => setProjectSearch(e.target.value)}
                    className="w-full border rounded px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" autoFocus />
                </div>
                <ul className="overflow-y-auto max-h-48">
                  <li className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 ${!projectId ? 'bg-brand-50 text-brand-700' : ''}`}
                    onClick={() => { setProjectId(''); setProjectOpen(false); setProjectSearch(''); setPage(1) }}>
                    全部项目
                  </li>
                  {sortedProjects.map(p => (
                    <li key={p} className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 truncate ${projectId === p ? 'bg-brand-50 text-brand-700' : ''}`}
                      onClick={() => { setProjectId(p); setProjectOpen(false); setProjectSearch(''); setPage(1) }}>
                      {p.split('/').pop() || p}
                    </li>
                  ))}
                </ul>
              </div>
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

          {/* Reset overrides button — removed (v1.1.0) */}
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
              {todos.map((todo, idx) => {
                const todoKey = `${todo.session_id}:${todo.position}`
                return (
                  <tr
                    key={todoKey}
                    className={`border-b border-gray-100 transition-colors hover:bg-brand-50 ${
                      idx % 2 === 1 ? 'bg-gray-50/50' : ''
                    }`}
                  >
                    <td className="px-4 py-3 text-center text-gray-400 text-xs">{(page - 1) * pageSize + idx + 1}</td>
                    <td
                      className="max-w-xs py-3 pr-4 text-gray-900 cursor-pointer"
                      title={todo.content}
                      onClick={() => navigate(`/sessions/${todo.session_id}/messages`)}
                    >
                      <span className="text-gray-400 mr-1">[{todo.position}]</span>{truncateText(todo.content, 120)}
                    </td>
                    {/* Status — read-only */}
                    <td className="px-4 py-3">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_BADGE[todo.status] || 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABEL[todo.status] || todo.status}
                      </span>
                    </td>
                    {/* Priority — read-only */}
                    <td className="px-4 py-3">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${PRIORITY_BADGE[todo.priority] || 'bg-gray-100 text-gray-500'}`}>
                        {PRIORITY_LABEL[todo.priority] || todo.priority || '-'}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-3">
                      <span
                        className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-800 transition-colors cursor-pointer"
                        title={todo.session_title}
                      onClick={() => navigate(`/sessions?session=${todo.session_id}&tab=todos`)}
                      >
                        <MessageSquare size={12} />
                        {truncateText(todo.session_title, 30)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); localStorage.setItem('dbscope-todos-page-size', String(s)); setPage(1) }}
        sticky={false}
      />
    </div>
  )
}

export default Todos
