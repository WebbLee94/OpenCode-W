import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { SessionDTO, SessionDetailDTO, SessionFilter } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatNumber, formatRelativeTime } from '../../lib/format'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  MessageSquare,
  Trash2,
  ArrowUpDown,
  FolderOpen,
  AlertTriangle,
} from 'lucide-react'
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
} from 'recharts'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

const SORT_OPTIONS = [
  { value: 'time_updated', label: '最近活跃' },
  { value: 'title', label: '标题' },
  { value: 'msg_count', label: '消息数' },
  { value: 'data_size', label: '数据大小' },
  { value: 'total_tokens', label: 'Token消耗' },
] as const

const TOKEN_PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']
const TOOL_BAR_COLOR = '#6366f1'

// ─── Sessions Page ───────────────────────────────────────────────────────────

function Sessions() {
  // Data state
  const [sessions, setSessions] = useState<SessionDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<string[]>([])

  // Filter state
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [projectId, setProjectId] = useState('')
  const [sortBy, setSortBy] = useState('time_updated')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(() => {
    const saved = localStorage.getItem('dbscope-page-size')
    return saved ? parseInt(saved, 10) : DEFAULT_PAGE_SIZE
  })
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // Detail panel state
  const [selectedSession, setSelectedSession] = useState<SessionDetailDTO | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const urlSyncedRef = useRef(false)

  // ─── Debounced search ────────────────────────────────────────────────────

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value)
      setPage(1)
    }, 300)
  }, [])

  // ─── Load sessions ───────────────────────────────────────────────────────

  useEffect(() => {
    const filter: SessionFilter = {
      search: debouncedSearch || undefined,
      projectId: projectId || undefined,
      sortBy,
      sortOrder,
      page,
      pageSize,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    }

    setLoading(true)
    invokeSafe<{ data: SessionDTO[]; total: number; page: number; pageSize: number }>(IPC_CHANNELS.SESSIONS_LIST, filter)
      .then((result) => {
        setSessions(result.data)
        setTotal(result.total)
      })
      .catch(() => {
        setSessions([])
        setTotal(0)
      })
      .finally(() => setLoading(false))
  }, [debouncedSearch, projectId, sortBy, sortOrder, page, pageSize, startDate, endDate])

  // ─── Load projects list ──────────────────────────────────────────────────

  useEffect(() => {
    invokeSafe<string[]>(IPC_CHANNELS.SESSIONS_PROJECTS)
      .then((result) => {
        setProjects(result)
      })
      .catch(() => setProjects([]))
  }, [])

  // ─── Sync URL params to filters (once on mount) ──────────────────────────

  useEffect(() => {
    if (urlSyncedRef.current) return
    urlSyncedRef.current = true

    const urlStart = searchParams.get('start')
    const urlEnd = searchParams.get('end')
    const urlProject = searchParams.get('project')

    if (urlStart) setStartDate(urlStart)
    if (urlEnd) setEndDate(urlEnd)
    if (urlProject) setProjectId(urlProject)
  }, [searchParams])

  // ─── Sync filters to URL params ────────────────────────────────────────────

  const syncFiltersToUrl = useCallback((newStartDate: string, newEndDate: string, newProjectId: string) => {
    const params = new URLSearchParams()
    if (newStartDate) params.set('start', newStartDate)
    if (newEndDate) params.set('end', newEndDate)
    if (newProjectId) params.set('project', newProjectId)
    setSearchParams(params, { replace: true })
  }, [setSearchParams])

  // ─── Load session detail ─────────────────────────────────────────────────

  const openDetail = useCallback((sessionId: string) => {
    setDetailLoading(true)
    setPanelOpen(true)
    setSelectedSession(null)
    invokeSafe<SessionDetailDTO | null>(IPC_CHANNELS.SESSIONS_DETAIL, sessionId)
      .then((result) => {
        setSelectedSession(result)
      })
      .catch(() => setSelectedSession(null))
      .finally(() => setDetailLoading(false))
  }, [])

  const closeDetail = useCallback(() => {
    setPanelOpen(false)
    setTimeout(() => setSelectedSession(null), 300) // wait for animation
  }, [])

  // ─── Delete session ──────────────────────────────────────────────────────

  const handleDelete = useCallback(
    (sessionId: string) => {
      setDeleteError(null)
      invokeSafe(IPC_CHANNELS.SESSIONS_DELETE, sessionId)
        .then(() => {
          closeDetail()
          // Reload current page
          setPage((p) => p)
          // Force re-fetch by triggering the effect
          setSessions((prev) => prev.filter((s) => s.id !== sessionId))
          setTotal((t) => t - 1)
        })
        .catch((err) => {
          setDeleteError((err as Error).message || '删除会话失败')
        })
        .finally(() => setDeleteConfirm(null))
    },
    [closeDetail]
  )

  // ─── Pagination helpers ──────────────────────────────────────────────────

  const totalPages = Math.ceil(total / pageSize)
  const startIdx = (page - 1) * pageSize + 1
  const endIdx = Math.min(page * pageSize, total)

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize)
    localStorage.setItem('dbscope-page-size', String(newSize))
    setPage(1)
  }, [])

  const goToPage = useCallback(
    (p: number) => {
      const clamped = Math.max(1, Math.min(totalPages, p))
      setPage(clamped)
    },
    [totalPages]
  )

  // ─── Token pie chart data ────────────────────────────────────────────────

  const tokenPieData = selectedSession
    ? [
        { name: 'Input', value: selectedSession.tokenStats.inputTokens },
        { name: 'Output', value: selectedSession.tokenStats.outputTokens },
        { name: 'Reasoning', value: selectedSession.tokenStats.reasoningTokens },
        { name: 'Cache Read', value: selectedSession.tokenStats.cacheRead },
        { name: 'Cache Write', value: selectedSession.tokenStats.cacheWrite },
      ].filter((d) => d.value > 0)
    : []

  // ─── Tool ranking bar chart data ─────────────────────────────────────────

  const toolBarData = selectedSession
    ? selectedSession.toolRanking.slice(0, 5).map((t) => ({
        name: t.toolName.length > 20 ? t.toolName.slice(0, 20) + '...' : t.toolName,
        count: t.count,
      }))
    : []

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="relative flex h-full flex-col">
      {/* Header & Filters */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold text-gray-900">Sessions</h2>
          <span className="text-sm text-gray-500">共 {formatNumber(total)} 条会话</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="搜索会话标题..."
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

          {/* Project filter */}
          <div className="relative min-w-[180px]">
            <FolderOpen size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <select
              value={projectId}
              onChange={(e) => {
                const val = e.target.value
                setProjectId(val)
                setPage(1)
                syncFiltersToUrl(startDate, endDate, val)
              }}
              className="w-full appearance-none rounded-md border border-gray-300 bg-white py-2 pl-9 pr-8 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">全部项目</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p.split('/').pop() || p}
                </option>
              ))}
            </select>
            <ChevronRight size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rotate-90 text-gray-400" />
          </div>

          {/* Sort by */}
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value)
              setPage(1)
            }}
            className="min-w-[130px] appearance-none rounded-md border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Sort order toggle */}
          <button
            onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            title={sortOrder === 'asc' ? '升序' : '降序'}
          >
            <ArrowUpDown size={14} />
            {sortOrder === 'asc' ? '升序' : '降序'}
          </button>

          {/* Date range filter */}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                const val = e.target.value
                setStartDate(val)
                setPage(1)
                syncFiltersToUrl(val, endDate, projectId)
              }}
              className="rounded-md border border-gray-300 bg-white py-2 px-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              title="开始日期"
            />
            <span className="text-gray-400 text-sm">~</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                const val = e.target.value
                setEndDate(val)
                setPage(1)
                syncFiltersToUrl(startDate, val, projectId)
              }}
              className="rounded-md border border-gray-300 bg-white py-2 px-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              title="结束日期"
            />
            {(startDate || endDate) && (
              <button
                onClick={() => {
                  setStartDate('')
                  setEndDate('')
                  setPage(1)
                  syncFiltersToUrl('', '', projectId)
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                title="清除日期筛选"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-0">
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">加载中...</div>
        ) : sessions.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">暂无会话数据</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="w-12 px-4 py-3 text-center font-medium text-gray-500">#</th>
                <th className="py-3 pr-4 text-left font-medium text-gray-500">标题</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">消息数</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">数据大小</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Token消耗</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">最近活跃</th>
                <th className="pl-4 py-3 text-left font-medium text-gray-500">所属项目</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session, idx) => (
                <tr
                  key={session.id}
                  onClick={() => openDetail(session.id)}
                  className={`cursor-pointer border-b border-gray-100 transition-colors hover:bg-brand-50 ${
                    idx % 2 === 1 ? 'bg-gray-50/50' : ''
                  } ${selectedSession?.id === session.id ? 'bg-brand-50' : ''}`}
                >
                  <td className="px-4 py-3 text-center text-gray-400 text-xs">{(page - 1) * pageSize + idx + 1}</td>
                  <td className="max-w-xs truncate py-3 pr-4 font-medium text-gray-900" title={session.title || '无标题'}>
                    {session.title || '无标题'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{formatNumber(session.msg_count)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{formatBytes(session.data_size)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {formatNumber(session.tokens_input + session.tokens_output)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{formatRelativeTime(session.time_updated)}</td>
                  <td className="max-w-[200px] truncate pl-4 py-3 text-gray-500" title={session.directory || session.project_id || '-'}>
                    {session.directory ? session.directory.split('/').pop() || session.directory : (session.project_id || '-')}
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
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">
              显示 {startIdx}-{endIdx} / 共 {formatNumber(total)} 条
            </span>
            <div className="flex items-center gap-1.5 text-sm text-gray-500">
              <span>每页</span>
              <select
                value={pageSize}
                onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                className="appearance-none rounded border border-gray-300 bg-white px-2 py-0.5 text-sm text-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
              <span>条</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => goToPage(page - 1)}
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
                  if (!isNaN(v)) goToPage(v)
                }}
                className="w-14 rounded-md border border-gray-300 px-2 py-1 text-center text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <span className="text-sm text-gray-500">/ {totalPages}</span>
            </div>

            <button
              onClick={() => goToPage(page + 1)}
              disabled={page >= totalPages}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Detail Panel - Overlay */}
      <div
        className={`fixed inset-0 z-40 transition-colors duration-300 ${
          panelOpen ? 'bg-black/20' : 'pointer-events-none bg-transparent'
        }`}
        onClick={panelOpen ? closeDetail : undefined}
      />

      <div
        className={`fixed right-0 top-0 z-50 h-full w-[480px] transform bg-white shadow-xl transition-transform duration-300 ease-in-out ${
          panelOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Panel Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <h3 className="text-lg font-semibold text-gray-900">会话详情</h3>
          <button
            onClick={closeDetail}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={20} />
          </button>
        </div>

        {/* Panel Content */}
        <div className="h-[calc(100%-64px)] overflow-y-auto px-5 py-4">
          {detailLoading ? (
            <div className="flex items-center justify-center py-20 text-gray-400">加载中...</div>
          ) : selectedSession ? (
            <div className="space-y-6">
              {/* Basic Info */}
              <div>
                <h4 className="text-base font-semibold text-gray-900 mb-3" title={selectedSession.title}>
                  {selectedSession.title || '无标题'}
                </h4>
                <div className="space-y-2 text-sm">
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-gray-500 w-16">目录</span>
                    <span className="text-gray-700 break-all" title={selectedSession.directory}>
                      {selectedSession.directory || '-'}
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-gray-500 w-16">模型</span>
                    <span className="text-gray-700">{selectedSession.model || '-'}</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 text-gray-500 w-16">时间</span>
                    <span className="text-gray-700">
                      {new Date(selectedSession.time_created).toLocaleString()} ~{' '}
                      {new Date(selectedSession.time_updated).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Token Breakdown Pie Chart */}
              <div>
                <h5 className="text-sm font-medium text-gray-700 mb-3">Token 明细</h5>
                {tokenPieData.length > 0 ? (
                  <div>
                    <ResponsiveContainer width="100%" height={180}>
                      <PieChart>
                        <Pie
                          data={tokenPieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={45}
                          outerRadius={75}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {tokenPieData.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={TOKEN_PIE_COLORS[index % TOKEN_PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <RechartsTooltip
                          formatter={(value: number) => formatNumber(value)}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {tokenPieData.map((entry, index) => (
                        <div key={entry.name} className="flex items-center gap-1.5 text-xs text-gray-600">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: TOKEN_PIE_COLORS[index % TOKEN_PIE_COLORS.length] }}
                          />
                          {entry.name}: {formatNumber(entry.value)}
                        </div>
                      ))}
                    </div>
                    {selectedSession.tokenStats.estimatedCost > 0 && (
                      <div className="mt-2 text-xs text-gray-500">
                        预估费用: ${selectedSession.tokenStats.estimatedCost.toFixed(4)}
                        {selectedSession.tokenStats.cacheHitRate > 0 && (
                          <span className="ml-3">缓存命中率: {selectedSession.tokenStats.cacheHitRate.toFixed(1)}%</span>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">暂无 Token 数据</p>
                )}
              </div>

              {/* Tool Usage Ranking */}
              <div>
                <h5 className="text-sm font-medium text-gray-700 mb-3">Tool 使用排行</h5>
                {toolBarData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={toolBarData.length * 32 + 10}>
                    <BarChart data={toolBarData} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
                      <XAxis type="number" hide />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={120}
                        tick={{ fontSize: 11, fill: '#6b7280' }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Bar dataKey="count" fill={TOOL_BAR_COLOR} radius={[0, 4, 4, 0]} barSize={16}>
                        {toolBarData.map((_entry, index) => (
                          <Cell key={`tool-cell-${index}`} fill={TOOL_BAR_COLOR} opacity={1 - index * 0.15} />
                        ))}
                      </Bar>
                      <RechartsTooltip />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-gray-400">暂无 Tool 使用数据</p>
                )}
              </div>

              {/* Skill List */}
              <div>
                <h5 className="text-sm font-medium text-gray-700 mb-3">Skill 列表</h5>
                {selectedSession.skillList.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedSession.skillList.map((skill) => (
                      <span
                        key={skill}
                        className="inline-flex items-center rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">暂无 Skill 使用</p>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => navigate(`/sessions/${selectedSession.id}/messages`)}
                  className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
                >
                  <MessageSquare size={16} />
                  查看消息
                </button>
                <button
                  onClick={() => setDeleteConfirm(selectedSession.id)}
                  className="inline-flex items-center gap-2 rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={16} />
                  删除此会话
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-20 text-gray-400">无法加载会话详情</div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30">
          <div className="w-96 rounded-lg bg-white p-6 shadow-xl">
            <h4 className="text-lg font-semibold text-gray-900 mb-2">确认删除</h4>
            <p className="text-sm text-gray-600 mb-6">
              确定要删除此会话吗？此操作将删除该会话的所有消息和 Part 数据，且不可恢复。
            </p>
            {deleteError && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg mb-4 text-sm text-red-800">
                <AlertTriangle size={16} className="shrink-0" />
                {deleteError}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Sessions
