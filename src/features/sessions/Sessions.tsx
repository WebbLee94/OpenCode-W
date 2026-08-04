import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import type { SessionDTO, SessionDetailDTO, SessionFilter, TodoDTO, SessionShareDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe, openExternal } from '../../lib/ipc'
import { open as showDialog } from '@tauri-apps/plugin-dialog'
import { formatBytes, formatNumber, formatLargeNumber, formatRelativeTime, truncateText } from '../../lib/format'
import { useToast } from '../../hooks/useToast'
import ConfirmDialog from '../../components/ConfirmDialog'
import {
  Search,
  ChevronRight,
  X,
  Trash2,
  FolderOpen,
  Calendar,
  MessageSquare,
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
import MessageViewer from '../messages/MessageViewer'
import SubSessionSelector from './SubSessionSelector'
import SessionPreview from './SessionPreview'
import PreviewTabPagination from '../../components/PreviewTabPagination'
import PageHeader from '../../components/PageHeader'
import PaginationBar from '../../components/PaginationBar'

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

const TOKEN_PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']

const TODO_STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

const TODO_PRIORITY_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

const TODO_STATUS_BADGE: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  cancelled: 'bg-gray-100 text-gray-500',
  in_progress: 'bg-blue-100 text-blue-700',
  pending: 'bg-yellow-100 text-yellow-700',
}

const TODO_PRIORITY_BADGE: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
}

// ─── Sessions Page ───────────────────────────────────────────────────────────

function Sessions() {
  // Data state
  const [sessions, setSessions] = useState<SessionDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<string[]>([])
  const [projectSearch, setProjectSearch] = useState('')
  const [projectOpen, setProjectOpen] = useState(false)
  const projectRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (projectRef.current && !projectRef.current.contains(e.target as Node)) setProjectOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const sortedProjects = useMemo(() =>
    projects.filter(p => !projectSearch || p.toLowerCase().includes(projectSearch.toLowerCase()))
      .sort((a, b) => (a.split('/').pop() || a).localeCompare(b.split('/').pop() || b))
  , [projects, projectSearch])

  // Filter state
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [projectId, setProjectId] = useState('')
  const [sortBy, setSortBy] = useState('time_updated')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(() => {
    const saved = localStorage.getItem('opencode-w-page-size')
    return saved ? parseInt(saved, 10) : DEFAULT_PAGE_SIZE
  })
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [datePreset, setDatePreset] = useState('all')
  const [dateOpen, setDateOpen] = useState(false)
  const dateRef = useRef<HTMLDivElement>(null)

  const DATE_PRESETS = [
    { value: 'all', label: '全部' },
    { value: 'today', label: '今天' },
    { value: '3days', label: '近3天' },
    { value: '7days', label: '近一周' },
    { value: '30days', label: '近一月' },
    { value: 'custom', label: '自定义' },
  ]

  function applyDateFilter(preset: string) {
    const today = new Date().toISOString().slice(0, 10)
    if (preset === 'today') { setStartDate(today); setEndDate(today) }
    else if (preset === '3days') { setStartDate(new Date(Date.now()-3*86400000).toISOString().slice(0,10)); setEndDate(today) }
    else if (preset === '7days') { setStartDate(new Date(Date.now()-7*86400000).toISOString().slice(0,10)); setEndDate(today) }
    else if (preset === '30days') { setStartDate(new Date(Date.now()-30*86400000).toISOString().slice(0,10)); setEndDate(today) }
    else { setStartDate(''); setEndDate('') }
    setDatePreset(preset)
    setPage(1)
  }

  function handleHeaderSort(col: string) {
    if (sortBy === col) { setSortOrder(o => o === 'asc' ? 'desc' : 'asc') }
    else { setSortBy(col); setSortOrder('asc') }
    setPage(1)
  }

  // Close date dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (dateRef.current && !dateRef.current.contains(e.target as Node)) setDateOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Detail panel state
  const [selectedSession, setSelectedSession] = useState<SessionDetailDTO | null>(null)

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBatchDelete, setShowBatchDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showBatchMove, setShowBatchMove] = useState(false)
  const [batchMovePath, setBatchMovePath] = useState('')
  const [moving, setMoving] = useState(false)
  const { addToast } = useToast()

  // Todos state (Session detail panel)
  const [sessionTodos, setSessionTodos] = useState<TodoDTO[]>([])
  const [todoSearch, setTodoSearch] = useState('')
  const [todoStatusFilter, setTodoStatusFilter] = useState('')
  const [todoPriorityFilter, setTodoPriorityFilter] = useState('')

  // Session share state
  const [sessionShare, setSessionShare] = useState<SessionShareDTO | null>(null)
  const [showDelete, setShowDelete] = useState(false)

  // Sub-session selector
  const [childSessions, setChildSessions] = useState<SessionDTO[]>([])
  const [selectedChildId, setSelectedChildId] = useState<string>('')

  // Preview tab pagination (外置分页 — Commit 5.1)
  const [previewPage, setPreviewPage] = useState(1)
  const [previewPageSize, setPreviewPageSize] = useState(() => {
    const saved = localStorage.getItem('opencode-w-preview-page-size')
    return saved ? parseInt(saved, 10) : 50
  })
  const [previewTotal, setPreviewTotal] = useState(0)

  // Todos tab pagination (Commit 6.1)
  const [todoPage, setTodoPage] = useState(1)
  const [todoPageSize, setTodoPageSize] = useState(20)

  // Inline title edit
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')

  const [searchParams, setSearchParams] = useSearchParams()
  const activeSessionId = searchParams.get('session') || null
  const activeTab = searchParams.get('tab') || 'basic'
const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const urlSyncedRef = useRef(false)
const [focusedIndex, setFocusedIndex] = useState(-1)
const listRef = useRef<HTMLDivElement>(null)

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
    setSearchParams(prev => { prev.set('session', sessionId); return prev })
    setSelectedSession(null)
    setSessionShare(null)
    invokeSafe<SessionDetailDTO | null>(IPC_CHANNELS.SESSIONS_DETAIL, sessionId)
      .then((result) => {
        setSelectedSession(result)
      })
      .catch(() => setSelectedSession(null))

    // Load share info for this session
    invokeSafe<SessionShareDTO | null>(IPC_CHANNELS.SESSION_SHARE_GET, sessionId)
      .then((result) => setSessionShare(result))
      .catch(() => setSessionShare(null))
  }, [setSearchParams])

  // 当 activeSessionId 变化时,自动加载子会话和 todo (支持 URL 直接进入详情页)
  useEffect(() => {
    if (!activeSessionId) {
      setChildSessions([])
      setSessionTodos([])
      return
    }
    // cancelled 标志防止切换 session 后写入过期数据
    let cancelled = false
    setChildSessions([])
    setSessionTodos([])

    // 加载子会话,然后查询父+子合并的 todos
    invokeSafe<SessionDTO[]>(IPC_CHANNELS.SESSIONS_CHILDREN, activeSessionId)
      .then((children) => {
        if (cancelled) return
        setChildSessions(children)
        return invokeSafe<TodoDTO[]>(IPC_CHANNELS.TODOS_BY_PARENT, {
          parentSessionId: activeSessionId,
          childSessionIds: children.map(c => c.id),
        })
      })
      .then((todos) => {
        if (cancelled || !todos) return
        setSessionTodos(todos)
      })
      .catch(() => {
        if (cancelled) return
        setChildSessions([])
        setSessionTodos([])
      })
    return () => { cancelled = true }
  }, [activeSessionId])

  // ─── Key handler (keyboard nav) ────────────────────────────────────────────────

  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault(); setFocusedIndex(prev => Math.min(prev + 1, sessions.length - 1))
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault(); setFocusedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && focusedIndex >= 0) {
      openDetail(sessions[focusedIndex].id)
    }
  }, [focusedIndex, sessions, openDetail])

  // ─── Batch selection helpers ────────────────────────────────────────────

  function toggleSelect(sessionId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(sessionId) ? next.delete(sessionId) : next.add(sessionId)
      return next
    })
  }

  function selectAll() {
    if (selectedIds.size === sessions.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(sessions.map(s => s.id)))
  }

  async function batchDelete() {
    setDeleting(true)
    let count = 0
    for (const id of selectedIds) {
      const res = await invokeSafe<{ success?: boolean }>(IPC_CHANNELS.SESSIONS_DELETE, id)
      if (res?.success) count++
    }
    setDeleting(false)
    setSelectedIds(new Set())
    setShowBatchDelete(false)
    addToast(`已删除 ${count} 个会话`, 'success')
    setSessions((prev) => prev.filter((s) => !selectedIds.has(s.id)))
    setTotal((t) => t - count)
  }

  async function handleBatchMove() {
    const selected = await showDialog({ directory: true, multiple: false, title: '选择目标目录' })
    if (!selected) return
    setBatchMovePath(selected as string)
    setShowBatchMove(true)
  }

  // ─── Pagination helpers ──────────────────────────────────────────────────

  const totalPages = Math.ceil(total / pageSize)

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize)
    localStorage.setItem('opencode-w-page-size', String(newSize))
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
        { name: '输入Token', value: selectedSession.tokenStats.inputTokens },
        { name: '输出Token', value: selectedSession.tokenStats.outputTokens },
        { name: '推理Token', value: selectedSession.tokenStats.reasoningTokens },
        { name: '缓存读Token', value: selectedSession.tokenStats.cacheRead },
        { name: '缓存写Token', value: selectedSession.tokenStats.cacheWrite },
      ].filter((d) => d.value > 0)
    : []

  // ─── Skill ranking bar chart data ────────────────────────────────────────

  const skillBarData = selectedSession
    ? selectedSession.skillRanking.slice(0, 8).map((s) => ({
        skillName: s.skillName,
        count: s.count,
      }))
    : []

  // ─── Tool ranking bar chart data ─────────────────────────────────────────

  const toolBarData = selectedSession
    ? selectedSession.toolRanking.slice(0, 8).map((t) => ({
        name: t.toolName.length > 20 ? t.toolName.slice(0, 20) + '...' : t.toolName,
        count: t.count,
      }))
    : []

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={`flex h-full min-w-0 ${activeSessionId ? '' : 'flex-col'}`}>
    {activeSessionId ? (
      <>
        {/* Detail panel */}
        <div className="flex h-full flex-1 flex-col min-w-0">
          {activeSessionId && selectedSession ? (
            <>
              {/* 顶部 sticky — 头部 + Tab 栏 + SubSessionSelector */}
              <div className="shrink-0 bg-white">
                {/* 头部 */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
                  {editingTitle ? (
                    <input
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      onBlur={async () => {
                        if (editTitle.trim() && editTitle !== selectedSession?.title) {
                          try {
                            await invokeSafe(IPC_CHANNELS.SESSIONS_RENAME, { sessionId: activeSessionId, title: editTitle.trim() })
                            const updated = await invokeSafe<SessionDetailDTO | null>(IPC_CHANNELS.SESSIONS_DETAIL, activeSessionId)
                            if (updated) setSelectedSession(updated)
                            addToast('名称已更新', 'success')
                          } catch {
                            addToast('名称修改失败', 'error')
                          }
                        }
                        setEditingTitle(false)
                      }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      className="border rounded px-2 py-0.5 text-sm font-medium text-gray-800 max-w-md"
                      autoFocus
                    />
                  ) : (
                    <span
                      className="text-sm font-medium text-gray-800 cursor-pointer hover:text-brand-600"
                      title="点击修改名称"
                      onClick={() => { setEditTitle(selectedSession?.title || ''); setEditingTitle(true) }}
                    >
                      {selectedSession?.title || '无标题'}
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowDelete(true)}
                      title="删除会话"
                      aria-label="删除会话"
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors"
                    >
                      <Trash2 size={12} />
                      删除
                    </button>
                    <button
                      onClick={() => setSearchParams(p => { p.delete('session'); return p })}
                      title="关闭"
                      aria-label="关闭"
                      className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
                {/* Tab Bar */}
                <div className="flex border-b border-gray-200 px-4 gap-0">
                  {['basic', 'subsessions', 'messages', 'todos'].map(t => (
                    <button key={t} onClick={() => setSearchParams(p => { p.set('tab', t); return p })}
                      className={`px-4 py-2 text-sm border-b-2 -mb-[1px] whitespace-nowrap ${
                        activeTab === t ? 'border-brand-500 text-brand-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}>
                      {t === 'basic' ? '基础' : t === 'subsessions' ? '解析' : t === 'messages' ? '预览' : '待办'}
                    </button>
                  ))}
                </div>
                {/* SubSessionSelector 栏 — 仅在解析/预览/待办 Tab 下显示 */}
                {activeTab !== 'basic' && (
                  <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50/50 gap-2">
                    <SubSessionSelector childSessions={childSessions} selectedChildId={selectedChildId} onChange={setSelectedChildId} />
                    <div className="text-xs text-gray-500">
                      {selectedChildId
                        ? `当前子会话：${childSessions.find(c => c.id === selectedChildId)?.title?.slice(0, 16) || '已选'}`
                        : `共 ${childSessions.length} 个子会话`}
                    </div>
                  </div>
                )}
              </div>

              {/* 中间 — 各 Tab 内容区域 */}
              <div className="flex-1 min-w-0 w-full overflow-hidden">
                {activeTab === 'subsessions' && (
                  <div className="h-full overflow-hidden min-w-0">
                    <MessageViewer sessionId={(selectedChildId || activeSessionId)!} />
                  </div>
                )}
                {activeTab === 'messages' && (
                  <div className="flex flex-col h-full w-full">
                    <div className="flex-1 overflow-y-auto overflow-x-hidden w-full">
                      <SessionPreview
                        activeSessionId={activeSessionId}
                        childSessions={childSessions}
                        page={previewPage}
                        pageSize={previewPageSize}
                        total={previewTotal}
                        onPageChange={setPreviewPage}
                        onPageSizeChange={setPreviewPageSize}
                        onTotalChange={setPreviewTotal}
                        selectedChildId={selectedChildId}
                        onSelectedChildIdChange={setSelectedChildId}
                      />
                    </div>
                  </div>
                )}
                {activeTab === 'basic' && (
                  <div className="overflow-y-auto h-full p-4">
                    <div className="space-y-4">
                      {/* Row 1: 基础信息 | Token 明细 */}
                      <div className="grid grid-cols-2 gap-4">
                        {/* 基础信息 */}
                        <div className="bg-white border border-gray-200 rounded-lg p-4">
                          <h5 className="text-sm font-medium text-gray-700 mb-3">📋 基础信息</h5>
                          {(() => {
                            const { modelId, providerId } = parseModelJson(selectedSession.model)
                            return (
                              <div className="space-y-2 text-sm">
                                <p><span className="text-gray-500">目录:</span> {selectedSession.directory || '-'}</p>
                                <p><span className="text-gray-500">厂商:</span> {providerId}</p>
                                <p><span className="text-gray-500">模型:</span> <span className="font-mono">{modelId}</span></p>
                                <p><span className="text-gray-500">时间:</span> {selectedSession.time_created ? new Date(selectedSession.time_created).toLocaleString() : '-'}</p>
                              </div>
                            )
                          })()}
                        </div>
                        {/* Token 明细 */}
                        {tokenPieData.length > 0 && (
                          <div className="bg-white border border-gray-200 rounded-lg p-4">
                            <h5 className="text-sm font-medium text-gray-700 mb-2">💰 Token 明细</h5>
                            <div className="flex items-center gap-6">
                              <div className="w-40 h-40 flex-shrink-0">
                                <ResponsiveContainer width="100%" height="100%">
                                  <PieChart>
                                    <Pie data={tokenPieData} cx="50%" cy="50%" innerRadius={35} outerRadius={65} paddingAngle={2} dataKey="value" stroke="none">
                                      {tokenPieData.map((_, i) => <Cell key={i} fill={TOKEN_PIE_COLORS[i % TOKEN_PIE_COLORS.length]} />)}
                                    </Pie>
                                    <RechartsTooltip formatter={(v: number) => formatNumber(v)} contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }} />
                                  </PieChart>
                                </ResponsiveContainer>
                              </div>
                              <div className="flex-1 space-y-3 min-w-0">
                                {tokenPieData.map((entry, i) => (
                                  <div key={entry.name} className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: TOKEN_PIE_COLORS[i % TOKEN_PIE_COLORS.length] }} />
                                      <span className="text-xs text-gray-500">{entry.name}</span>
                                    </div>
                                    <span className="text-xs font-medium text-gray-800">{formatNumber(entry.value)}</span>
                                  </div>
                                ))}
                                <div className="border-t border-gray-100 pt-2 mt-2">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: '#f59e0b' }} />
                <span className="text-xs text-gray-500">缓存命中率</span>
                                    </div>
                <span className="text-xs font-medium text-gray-800">{(selectedSession.tokenStats.cacheHitRate ?? 0).toFixed(1)}%</span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      {/* Row 2: Skill 排行 | Tool 排行 */}
                      <div className="grid grid-cols-2 gap-4">
                        {/* Skill 排行 */}
                        {skillBarData.length > 0 && (
                          <div className="bg-white border border-gray-200 rounded-lg p-4">
                            <h5 className="text-sm font-medium text-gray-700 mb-2">🎯 Skill 排行</h5>
                            <ResponsiveContainer width="100%" height={215}>
                              <BarChart data={skillBarData} layout="vertical" margin={{left:80,right:20}}>
                                <XAxis type="number" tickFormatter={v => formatNumber(v)} />
                                <YAxis type="category" dataKey="skillName" width={80} tick={{fontSize:12}} />
                                <RechartsTooltip contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }} formatter={(v: number) => formatNumber(v)} />
                                <Bar dataKey="count" radius={[0,4,4,0]} barSize={16}>
                                  {skillBarData.map((_, i) => (
                                    <Cell key={`skill-${i}`} fill={['#8b5cf6','#6366f1','#a78bfa','#c4b5fd','#7c3aed'][i % 5]} />
                                  ))}
                                </Bar>
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                        {/* Tool 排行 */}
                        {toolBarData.length > 0 && (
                          <div className="bg-white border border-gray-200 rounded-lg p-4">
                            <h5 className="text-sm font-medium text-gray-700 mb-2">🔧 Tool 排行</h5>
                            <ResponsiveContainer width="100%" height={215}>
                              <BarChart data={toolBarData} layout="vertical" margin={{left:80,right:20}}>
                                <XAxis type="number" tickFormatter={v => formatNumber(v)} />
                                <YAxis type="category" dataKey="name" width={80} tick={{fontSize:12}} />
                                <RechartsTooltip contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }} formatter={(v: number) => formatNumber(v)} />
                                <Bar dataKey="count" fill="#3B82F6" radius={[0,4,4,0]} barSize={16} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </div>
                      {sessionShare && (
                        <div className="border-t border-gray-200 pt-4 mt-4">
                          <h5 className="text-sm font-medium text-gray-700 mb-2">🔗 分享信息</h5>
                          <div className="flex items-center gap-3 text-sm bg-gray-50 rounded p-3">
                            <span className="text-gray-500 truncate flex-1 font-mono text-xs">{sessionShare.url}</span>
                            <button onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(sessionShare.url)
                                addToast('已复制链接', 'success')
                              } catch {
                                addToast('复制失败', 'error')
                              }
                            }} className="text-gray-400 hover:text-blue-600 text-sm">📋 复制</button>
                            <button onClick={async () => {
                              try {
                                // 成功（含系统浏览器 / 内置降级）→ 静默
                                await openExternal(sessionShare.url)
                              } catch {
                                // 两种方式都失败 → 静默复制链接 + 友好提示
                                try {
                                  await navigator.clipboard.writeText(sessionShare.url)
                                  addToast('已复制链接', 'success')
                                } catch {
                                  // 复制也失败,完全静默
                                }
                              }
                            }} className="text-gray-400 hover:text-blue-600 text-sm">🌐 打开</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {activeTab === 'todos' && (() => {
                  const filteredTodos = sessionTodos.filter(t => {
                    if (selectedChildId && t.session_id !== selectedChildId) return false
                    if (todoSearch && !t.content?.toLowerCase().includes(todoSearch.toLowerCase())) return false
                    if (todoStatusFilter && t.status !== todoStatusFilter) return false
                    if (todoPriorityFilter && t.priority !== todoPriorityFilter) return false
                    return true
                  })
                  const pagedTodos = filteredTodos.slice((todoPage - 1) * todoPageSize, todoPage * todoPageSize)

                  return (
                  <div className="flex flex-col h-full w-full">
                    {/* 顶部 sticky — 搜索/筛选行 */}
                    <div className="shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex gap-2 flex-wrap">
                      <input type="text" placeholder="搜索待办..." value={todoSearch} onChange={e => setTodoSearch(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-48 bg-white text-gray-900 placeholder-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
                      <select value={todoStatusFilter} onChange={e => setTodoStatusFilter(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm bg-white text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500">
                        <option value="">全部状态</option>
                        <option value="pending">待处理</option>
                        <option value="in_progress">进行中</option>
                        <option value="completed">已完成</option>
                        <option value="cancelled">已取消</option>
                      </select>
                      <select value={todoPriorityFilter} onChange={e => setTodoPriorityFilter(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 text-sm bg-white text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500">
                        <option value="">全部优先级</option>
                        <option value="high">高</option>
                        <option value="medium">中</option>
                        <option value="low">低</option>
                      </select>
                    </div>

                    {/* 中间 — 表格 */}
                    <div className="flex-1 overflow-y-auto overflow-x-auto w-full">
                      <table className="w-full text-sm table-fixed">
                        <thead className="sticky top-0 z-10 bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="w-12 px-2 py-2 text-center font-medium text-gray-500">#</th>
                            <th className="px-2 py-2 text-left font-medium text-gray-500">内容</th>
                            <th className="w-20 px-2 py-2 text-center font-medium text-gray-500">状态</th>
                            <th className="w-16 px-2 py-2 text-center font-medium text-gray-500">优先级</th>
                            <th className="w-48 px-2 py-2 text-left font-medium text-gray-500">所属会话</th>
                            <th className="w-14 px-2 py-2 text-center font-medium text-gray-500">位置</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedTodos.length > 0 ? pagedTodos.map((todo, idx) => (
                            <tr key={`${todo.session_id}:${todo.position}`} className="border-b border-gray-100 hover:bg-gray-50/50">
                              <td className="px-2 py-2 text-center text-gray-400 text-xs">{(todoPage - 1) * todoPageSize + idx + 1}</td>
                              <td className="px-2 py-2 truncate" title={todo.content}>
                                {truncateText(todo.content || '', 120)}
                              </td>
                              <td className="px-2 py-2 text-center">
                                <span className={`text-xs px-1.5 py-0.5 rounded ${TODO_STATUS_BADGE[todo.status] || 'bg-gray-100 text-gray-500'}`}>
                                  {TODO_STATUS_LABEL[todo.status] || todo.status}
                                </span>
                              </td>
                              <td className="px-2 py-2 text-center">
                                <span className={`text-xs px-1.5 py-0.5 rounded ${TODO_PRIORITY_BADGE[todo.priority] || 'bg-gray-100 text-gray-500'}`}>
                                  {TODO_PRIORITY_LABEL[todo.priority] || todo.priority || '-'}
                                </span>
                              </td>
                              <td className="px-2 py-2 truncate text-gray-600 text-xs" title={todo.session_title || todo.session_id}>
                                {todo.session_title || todo.session_id.slice(0, 8)}
                              </td>
                              <td className="px-2 py-2 text-center text-gray-500 text-xs">[{todo.position}]</td>
                            </tr>
                          )) : (
                            <tr><td colSpan={6} className="text-center text-gray-400 py-8 text-sm">暂无待办</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* 底部 sticky — 分页 */}
                    <PreviewTabPagination
                      page={todoPage}
                      total={filteredTodos.length}
                      pageSize={todoPageSize}
                      onPageChange={setTodoPage}
                      onPageSizeChange={(s) => { setTodoPageSize(s); setTodoPage(1) }}
                    />
                  </div>
                  )
                })()}
              </div>
              {activeTab === 'messages' && (
                <PreviewTabPagination
                  page={previewPage}
                  total={previewTotal}
                  pageSize={previewPageSize}
                  onPageChange={setPreviewPage}
                  onPageSizeChange={(s) => {
                    setPreviewPageSize(s)
                    localStorage.setItem('opencode-w-preview-page-size', String(s))
                    setPreviewPage(1)
                  }}
                />
              )}
            </>
          ) : (
            <p className="text-gray-400 text-sm p-4">加载中...</p>
          )}
        </div>
        {showDelete && (
          <ConfirmDialog isOpen={showDelete} onClose={() => setShowDelete(false)}
            onConfirm={async () => {
              try {
                setShowDelete(false)
                await invokeSafe(IPC_CHANNELS.SESSIONS_DELETE, activeSessionId)
                setSearchParams(p => { p.delete('session'); p.delete('tab'); return p })
              } catch {
                alert('删除失败')
              }
            }}
            title="确认删除" variant="danger" confirmLabel="确认删除"
            message="确定要删除此会话吗？这将同时删除其所有子会话、消息记录和相关数据，此操作不可恢复。建议先备份数据库。" />
        )}
      </>
    ) : (
      <div className="flex-1 flex flex-col h-full">
      {/* Full list header & table */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-4">
        <PageHeader
          icon={<MessageSquare size={24} />}
          title="会话浏览"
          right={<span className="text-sm text-gray-500">共 {formatNumber(total)} 条会话</span>}
        />

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
                <div className="p-2 border-b border-gray-200">
                  <input type="text" placeholder="搜索项目..." value={projectSearch}
                    onChange={e => setProjectSearch(e.target.value)}
                    className="w-full border rounded px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" autoFocus />
                </div>
                <ul className="overflow-y-auto max-h-48">
                  <li className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 ${!projectId ? 'bg-brand-50 text-brand-700' : ''}`}
                    onClick={() => { setProjectId(''); setProjectOpen(false); setProjectSearch(''); setPage(1); syncFiltersToUrl(startDate, endDate, '') }}>
                    全部项目
                  </li>
                  {sortedProjects.map(p => (
                    <li key={p} className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 truncate ${projectId === p ? 'bg-brand-50 text-brand-700' : ''}`}
                      onClick={() => { setProjectId(p); setProjectOpen(false); setProjectSearch(''); setPage(1); syncFiltersToUrl(startDate, endDate, p) }}>
                      {p.split('/').pop() || p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Date quick selector */}
          <div className="relative" ref={dateRef}>
            <button onClick={() => setDateOpen(!dateOpen)}
              className="flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 whitespace-nowrap">
              <Calendar size={14} />
              {datePreset !== 'all' ? DATE_PRESETS.find(d => d.value === datePreset)?.label : '日期范围'}
            </button>
            {dateOpen && (
              <div className="absolute z-30 top-full left-0 mt-1 w-44 bg-white border border-gray-200 rounded shadow-lg py-1">
                {DATE_PRESETS.map(d => (
                  <button key={d.value} onClick={() => { applyDateFilter(d.value); setDateOpen(false) }}
                    className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${datePreset === d.value ? 'bg-brand-50 text-brand-700' : ''}`}>
                    {d.label}
                  </button>
                ))}
                {datePreset === 'custom' && (
                  <div className="px-2 py-1 border-t border-gray-200 mt-1">
                    <input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); setPage(1) }} className="border rounded px-1 py-0.5 text-xs w-full mb-1" />
                    <span className="text-xs text-gray-400">~</span>
                    <input type="date" value={endDate} onChange={e => { setEndDate(e.target.value); setPage(1) }} className="border rounded px-1 py-0.5 text-xs w-full mt-1" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-0" tabIndex={0} ref={listRef} onKeyDown={handleListKeyDown} onBlur={() => setFocusedIndex(-1)}>
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-4 bg-blue-50 px-4 py-2 rounded mb-2 text-sm">
            <span className="text-blue-700 font-medium">已选 {selectedIds.size} 项</span>
            <button
              onClick={handleBatchMove}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-brand-600 border border-brand-300 rounded-md hover:bg-brand-50"
            >
              📁 迁移
            </button>
            <button
              onClick={() => setShowBatchDelete(true)}
              className="inline-flex items-center gap-1 text-red-600 hover:text-red-800"
            >
              <Trash2 size={14} />删除所选
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="text-gray-400 hover:text-gray-600 ml-auto">取消选择</button>
          </div>
        )}
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">加载中...</div>
        ) : sessions.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">暂无会话数据</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="w-8 p-2"><input type="checkbox" checked={sessions.length > 0 && selectedIds.size === sessions.length} onChange={selectAll} /></th>
                <th className="w-12 px-4 py-3 text-center font-medium text-gray-500">#</th>
                <th onClick={() => handleHeaderSort('title')} className="py-3 pr-4 text-left font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
                  标题 {sortBy === 'title' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th onClick={() => handleHeaderSort('childCount')} className="px-4 py-3 text-right font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
                  子会话数 {sortBy === 'childCount' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th onClick={() => handleHeaderSort('data_size')} className="px-4 py-3 text-right font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">数据大小</th>
                <th onClick={() => handleHeaderSort('total_tokens')} className="px-4 py-3 text-right font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
                  Token消耗 {sortBy === 'total_tokens' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th onClick={() => handleHeaderSort('time_updated')} className="px-4 py-3 text-right font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
                  最近活跃 {sortBy === 'time_updated' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                </th>
                <th className="pl-4 py-3 text-left font-medium text-gray-500">所属项目</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session, idx) => (
                <tr
                  key={session.id}
                  onClick={() => openDetail(session.id)}
                    className={`session-row cursor-pointer border-b border-gray-100 transition-colors hover:bg-brand-50 ${
                      idx % 2 === 1 ? 'bg-gray-50/50' : ''
                    } ${selectedSession?.id === session.id ? 'bg-brand-50' : ''} ${idx === focusedIndex ? '!bg-blue-50 ring-1 ring-blue-200' : ''}`}
                >
                  <td className="w-8 p-2" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedIds.has(session.id)} onChange={() => toggleSelect(session.id)} /></td>
                  <td className="px-4 py-3 text-center text-gray-400 text-xs">{(page - 1) * pageSize + idx + 1}</td>
                  <td className="max-w-xs truncate py-3 pr-4 font-medium text-gray-900" title={session.title || '无标题'}>
                    {session.title || '无标题'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{((session as unknown as { childCount?: number }).childCount ?? 0).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{formatBytes(session.data_size)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {formatLargeNumber(session.total_tokens)}
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
      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        onPageChange={goToPage}
        onPageSizeChange={handlePageSizeChange}
      />
    </div>
    )}

      {/* Confirm Dialog for batch delete */}
      <ConfirmDialog
        isOpen={showBatchDelete}
        onClose={() => setShowBatchDelete(false)}
        onConfirm={batchDelete}
        title="确认批量删除"
        message={`确定要删除选中的 ${selectedIds.size} 个会话吗？此操作不可恢复。`}
        confirmLabel="确认删除"
        variant="danger"
        loading={deleting}
      />

      {/* Confirm Dialog for batch move */}
      <ConfirmDialog
        isOpen={showBatchMove}
        onClose={() => setShowBatchMove(false)}
        onConfirm={async () => {
          setMoving(true)
          try {
            const r = await invokeSafe<{ migrated: number }>(IPC_CHANNELS.SESSIONS_MOVE, { sessionIds: [...selectedIds], directory: batchMovePath })
            addToast(`已迁移 ${r.migrated} 个会话`, 'success')
            setSessions((prev) => prev.filter((s) => !selectedIds.has(s.id)))
            setTotal((t) => t - r.migrated)
            setSelectedIds(new Set())
            setShowBatchMove(false)
          } catch (e) { addToast(`迁移失败：${(e as Error).message}`, 'error') }
          finally { setMoving(false) }
        }}
        title="确认迁移"
        confirmLabel={moving ? '迁移中...' : '确认迁移'}
        message={`将 ${selectedIds.size} 个根会话迁移到：\n${batchMovePath}\n\n同步更新 directory 和 project_id，不涉及子会话。`}
      />
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────
function parseModelJson(modelStr: string | undefined): { modelId: string; providerId: string } {
  if (!modelStr) return { modelId: '-', providerId: '-' }
  if (modelStr.startsWith('{')) {
    try {
      const p = JSON.parse(modelStr)
      return {
        modelId: p.id || p.name || modelStr,
        providerId: p.providerID || '-',
      }
    } catch { /* fall through */ }
  }
  return { modelId: modelStr, providerId: '-' }
}

export default Sessions
