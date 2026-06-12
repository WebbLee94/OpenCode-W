import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import type { SessionDTO, SessionDetailDTO, SessionFilter, TodoDTO, SessionShareDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatNumber, formatRelativeTime, formatDateTime, truncateText } from '../../lib/format'
import { useToast } from '../../hooks/useToast'
import ConfirmDialog from '../../components/ConfirmDialog'
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
  Eye,
  EyeOff,
  Copy,
  Share2,
  Calendar,
  ClipboardList,
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

const TOKEN_PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']
const TOOL_BAR_COLOR = '#6366f1'

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
    const saved = localStorage.getItem('dbscope-page-size')
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
  const [detailLoading, setDetailLoading] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBatchDelete, setShowBatchDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { addToast } = useToast()

  // Todos state (Session detail panel)
  const [sessionTodos, setSessionTodos] = useState<TodoDTO[]>([])
  const [todoFilter, setTodoFilter] = useState<'all' | 'pending' | 'in_progress' | 'completed'>('all')
  const [todoSearch, setTodoSearch] = useState('')
  const [todoStatusFilter, setTodoStatusFilter] = useState('')
  const [todoPriorityFilter, setTodoPriorityFilter] = useState('')

  // Session share state
  const [sessionShare, setSessionShare] = useState<SessionShareDTO | null>(null)
  const [showSecret, setShowSecret] = useState(false)
  const [showDelete, setShowDelete] = useState(false)

  // Sub-session dropdown
  const [childSessions, setChildSessions] = useState<SessionDTO[]>([])
  const [selectedChildId, setSelectedChildId] = useState<string>('')
  const [subDropdownOpen, setSubDropdownOpen] = useState(false)
  const subDropdownRef = useRef<HTMLDivElement>(null)

  // Close sub-session dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (subDropdownRef.current && !subDropdownRef.current.contains(e.target as Node)) setSubDropdownOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Inline title edit
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')

  const navigate = useNavigate()
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
    console.log('[Sessions] Fetching:', { page, pageSize, projectId: projectId || 'all', sortBy, startDate: startDate || 'none', endDate: endDate || 'none' })
    invokeSafe<{ data: SessionDTO[]; total: number; page: number; pageSize: number }>(IPC_CHANNELS.SESSIONS_LIST, filter)
      .then((result) => {
        console.log('[Sessions] OK:', result.data?.length, 'rows, total:', result.total)
        setSessions(result.data)
        setTotal(result.total)
      })
      .catch((err) => {
        console.error('SESSIONS_LIST failed:', err)
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
    setDetailLoading(true)
    setPanelOpen(true)
    setSelectedSession(null)
    setSessionTodos([])
    setSessionShare(null)
    setShowSecret(false)
    invokeSafe<SessionDetailDTO | null>(IPC_CHANNELS.SESSIONS_DETAIL, sessionId)
      .then((result) => {
        setSelectedSession(result)
      })
      .catch(() => setSelectedSession(null))
      .finally(() => setDetailLoading(false))

    // Load todos for this session
    invokeSafe<TodoDTO[]>(IPC_CHANNELS.TODOS_BY_SESSION, sessionId)
      .then((result) => setSessionTodos(result))
      .catch(() => setSessionTodos([]))

    // Load share info for this session
    invokeSafe<SessionShareDTO | null>(IPC_CHANNELS.SESSION_SHARE_GET, sessionId)
      .then((result) => setSessionShare(result))
      .catch(() => setSessionShare(null))

    // Load children for sub-session dropdown
    invokeSafe<SessionDTO[]>(IPC_CHANNELS.SESSIONS_CHILDREN, sessionId).then(setChildSessions).catch(() => setChildSessions([]))
  }, [])

  const closeDetail = useCallback(() => {
    setPanelOpen(false)
    setTimeout(() => setSelectedSession(null), 300) // wait for animation
  }, [])

  // ─── Key handler (keyboard nav) ────────────────────────────────────────────────

  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault(); setFocusedIndex(prev => Math.min(prev + 1, sessions.length - 1))
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault(); setFocusedIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && focusedIndex >= 0) {
      openDetail(sessions[focusedIndex].id)
    } else if (e.key === 'd' && focusedIndex >= 0 && !e.ctrlKey && !e.metaKey) {
      const s = sessions[focusedIndex]; if (s) setDeleteConfirm(s.id)
    }
  }, [focusedIndex, sessions, openDetail])

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
    // Refresh sessions list
    setPage((p) => p)
    setSessions((prev) => prev.filter((s) => !selectedIds.has(s.id)))
    setTotal((t) => t - count)
  }

  function batchExport() {
    const selected = sessions.filter(s => selectedIds.has(s.id))
    const csv = '标题,项目,消息数,Token,最后活跃\n' +
      selected.map(s => `"${s.title}","${s.directory || ''}",${s.msg_count},${s.tokens_input + s.tokens_output},"${s.time_updated}"`).join('\n')
    window.electronAPI.saveFile(csv, `DBScope-会话导出-${new Date().toISOString().slice(0, 10)}.csv`).then((res: any) => {
      if (res?.success) addToast('已导出', 'success')
    })
  }

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
    <div className={`flex h-full ${activeSessionId ? '' : 'flex-col'}`}>
    {activeSessionId ? (
      <>
        {/* Detail panel */}
        <div className="flex-1 flex flex-col overflow-auto">
          <div className="flex items-center justify-between px-4 py-2 border-b bg-white shrink-0">
            <span className="text-sm font-medium text-gray-700">会话详情</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowDelete(true)} className="text-red-400 hover:text-red-600 ml-3 text-sm" title="删除会话">🗑</button>
              <button onClick={() => setSearchParams(p => { p.delete('session'); return p })} className="text-gray-400 hover:text-gray-600">✕ 关闭</button>
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {activeSessionId && selectedSession ? (
              <>
                {/* Tab Bar */}
                <div className="flex border-b bg-white px-4 shrink-0 gap-0">
                  {['basic', 'subsessions', 'messages', 'todos'].map(t => (
                    <button key={t} onClick={() => setSearchParams(p => { p.set('tab', t); return p })}
                      className={`px-4 py-2 text-sm border-b-2 -mb-[1px] whitespace-nowrap ${
                        activeTab === t ? 'border-brand-500 text-brand-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}>
                      {t === 'basic' ? '基础' : t === 'subsessions' ? '解析' : t === 'messages' ? '预览' : '待办'}
                    </button>
                  ))}
                </div>
                {/* Tab Content */}
                <div className="p-4">
                  {activeTab === 'basic' && (
                    <div className="space-y-6">
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          {editingTitle ? (
                            <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                              onBlur={async () => {
                                if (editTitle.trim() && editTitle !== selectedSession.title) {
                                  await invokeSafe(IPC_CHANNELS.SESSIONS_RENAME, { sessionId: activeSessionId, title: editTitle.trim() })
                                }
                                setEditingTitle(false)
                              }}
                              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                              className="border rounded px-2 py-1 text-sm font-semibold" autoFocus />
                          ) : (
                            <h4 className="text-base font-semibold text-gray-900 cursor-pointer hover:text-brand-600"
                              onClick={() => { setEditTitle(selectedSession?.title || ''); setEditingTitle(true) }}>
                              {selectedSession?.title || '无标题'} ✏️
                            </h4>
                          )}
                        </div>
                        <div className="space-y-2 text-sm">
                          <p><span className="text-gray-500">目录:</span> {selectedSession.directory || '-'}</p>
                          <p><span className="text-gray-500">模型:</span> {selectedSession.model || '-'}</p>
                          <p><span className="text-gray-500">时间:</span> {selectedSession.time_created ? new Date(selectedSession.time_created).toLocaleString() : '-'}</p>
                        </div>
                      </div>
                      {((tokenPieData.length > 0) || (toolBarData.length > 0)) && (
                        <div className="grid grid-cols-2 gap-4">
                          {/* Token Pie */}
                          {tokenPieData.length > 0 && (
                            <div>
                              <h5 className="text-sm font-medium text-gray-700 mb-2">Token 明细</h5>
                              <ResponsiveContainer width="100%" height={180}>
                                <PieChart><Pie data={tokenPieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value">
                                  {tokenPieData.map((_, i) => <Cell key={i} fill={TOKEN_PIE_COLORS[i % TOKEN_PIE_COLORS.length]} />)}
                                </Pie><RechartsTooltip formatter={(v: number) => formatNumber(v)} /></PieChart>
                              </ResponsiveContainer>
                              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                                {tokenPieData.map((entry, i) => (
                                  <div key={entry.name} className="flex items-center gap-1.5 text-xs text-gray-600">
                                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{backgroundColor: TOKEN_PIE_COLORS[i % TOKEN_PIE_COLORS.length]}}/>
                                    {entry.name}: {formatNumber(entry.value)}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {/* Tool Ranking */}
                          {toolBarData.length > 0 && (
                            <div>
                              <h5 className="text-sm font-medium text-gray-700 mb-2">Tool 排行</h5>
                              <ResponsiveContainer width="100%" height={toolBarData.length * 32 + 20}>
                                <BarChart data={toolBarData} layout="vertical" margin={{left:80,right:20}}>
                                  <XAxis type="number" tickFormatter={v => formatNumber(v)} />
                                  <YAxis type="category" dataKey="name" width={80} tick={{fontSize:12}} />
                                  <Bar dataKey="count" fill="#3B82F6" radius={[0,4,4,0]} />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          )}
                        </div>
                      )}
                      {/* Skill List */}
                      {selectedSession.skillList?.length > 0 && (
                        <div>
                          <h5 className="text-sm font-medium text-gray-700 mb-2">Skill 列表</h5>
                          <div className="flex flex-wrap gap-2">
                            {selectedSession.skillList.map((skillName, i) => (
                              <span key={i} className="px-2.5 py-0.5 rounded-full bg-purple-50 text-xs text-purple-700">{skillName}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {sessionShare && (
                        <div className="border-t pt-4 mt-4">
                          <h5 className="text-sm font-medium text-gray-700 mb-2">📤 分享信息</h5>
                          <div className="flex items-center gap-3 text-sm bg-gray-50 rounded p-3">
                            <span className="text-gray-500 truncate flex-1 font-mono text-xs">{sessionShare.url}</span>
                            <button onClick={() => { navigator.clipboard.writeText(sessionShare.url) }} className="text-gray-400 hover:text-blue-600 text-sm">📋 复制</button>
                            <button onClick={() => { window.open(sessionShare.url, '_blank') }} className="text-gray-400 hover:text-blue-600 text-sm">🌐 打开</button>
                          </div>
                        </div>
                      )}
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
                    return (
                    <div>
                      <div className="relative inline-block mb-3" ref={subDropdownRef}>
                        <button onClick={() => setSubDropdownOpen(!subDropdownOpen)} className="text-sm text-gray-500 hover:text-gray-700 border rounded px-2 py-0.5">
                          ▼ {selectedChildId ? childSessions.find(c => c.id === selectedChildId)?.title?.slice(0,20) || '已选' : '全部子会话'}
                        </button>
                        {subDropdownOpen && (
                          <div className="absolute z-20 top-full left-0 mt-1 bg-white border rounded shadow-lg py-1 w-64 max-h-48 overflow-y-auto">
                            <button onClick={() => { setSelectedChildId(''); setSubDropdownOpen(false) }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 font-medium">全部子会话</button>
                            {childSessions.map(c => (
                              <button key={c.id} onClick={() => { setSelectedChildId(c.id); setSubDropdownOpen(false) }}
                                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${selectedChildId === c.id ? 'bg-brand-50' : ''}`}>
                                {c.title || '无标题'}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <h5 className="text-sm font-medium text-gray-700 mb-3">待办列表 ({filteredTodos.length})</h5>
                      <div className="flex gap-2 mb-3">
                        <input type="text" placeholder="搜索待办..." value={todoSearch} onChange={e => setTodoSearch(e.target.value)}
                          className="border rounded px-2 py-1 text-sm w-48" />
                        <select value={todoStatusFilter} onChange={e => setTodoStatusFilter(e.target.value)}
                          className="border rounded px-2 py-1 text-sm">
                          <option value="">全部状态</option>
                          <option value="pending">待处理</option>
                          <option value="in_progress">进行中</option>
                          <option value="completed">已完成</option>
                          <option value="cancelled">已取消</option>
                        </select>
                        <select value={todoPriorityFilter} onChange={e => setTodoPriorityFilter(e.target.value)}
                          className="border rounded px-2 py-1 text-sm">
                          <option value="">全部优先级</option>
                          <option value="high">高</option>
                          <option value="medium">中</option>
                          <option value="low">低</option>
                        </select>
                      </div>
                      {filteredTodos.length > 0 ? (
                        <div className="space-y-2">
                          {filteredTodos.map(todo => (
                            <div key={`${todo.session_id}:${todo.position}`} className="rounded border p-2 bg-gray-50/50">
                              <span className="text-xs text-gray-400 mr-1">[{todo.position}]</span>
                              <span className="text-xs">{todo.content?.slice(0, 120)}</span>
                              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${todo.status==='completed'?'bg-green-100 text-green-700':'bg-yellow-100 text-yellow-700'}`}>
                                {todo.status}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : <p className="text-sm text-gray-400">暂无待办</p>}
                    </div>
                    )
                  })()}
                  {activeTab === 'subsessions' && (
                    <div>
                      <div className="relative inline-block mb-3" ref={subDropdownRef}>
                        <button onClick={() => setSubDropdownOpen(!subDropdownOpen)} className="text-sm text-gray-500 hover:text-gray-700 border rounded px-2 py-0.5">
                          ▼ {selectedChildId ? childSessions.find(c => c.id === selectedChildId)?.title?.slice(0,20) || '已选' : '全部子会话'}
                        </button>
                        {subDropdownOpen && (
                          <div className="absolute z-20 top-full left-0 mt-1 bg-white border rounded shadow-lg py-1 w-64 max-h-48 overflow-y-auto">
                            <button onClick={() => { setSelectedChildId(''); setSubDropdownOpen(false) }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 font-medium">全部子会话</button>
                            {childSessions.map(c => (
                              <button key={c.id} onClick={() => { setSelectedChildId(c.id); setSubDropdownOpen(false) }}
                                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${selectedChildId === c.id ? 'bg-brand-50' : ''}`}>
                                {c.title || '无标题'}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <p className="text-sm text-gray-700 mb-3">📋 解析模式 — 查看子会话的消息详情</p>
                      <div className="text-sm text-gray-400">
                        点击子会话列表中的任一项以查看消息内容。<br/>
                        提示：可返回会话列表，点击具体会话行进入消息查看器。
                      </div>
                    </div>
                  )}
                  {activeTab === 'messages' && (
                    <div>
                      <div className="relative inline-block mb-3" ref={subDropdownRef}>
                        <button onClick={() => setSubDropdownOpen(!subDropdownOpen)} className="text-sm text-gray-500 hover:text-gray-700 border rounded px-2 py-0.5">
                          ▼ {selectedChildId ? childSessions.find(c => c.id === selectedChildId)?.title?.slice(0,20) || '已选' : '全部子会话'}
                        </button>
                        {subDropdownOpen && (
                          <div className="absolute z-20 top-full left-0 mt-1 bg-white border rounded shadow-lg py-1 w-64 max-h-48 overflow-y-auto">
                            <button onClick={() => { setSelectedChildId(''); setSubDropdownOpen(false) }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 font-medium">全部子会话</button>
                            {childSessions.map(c => (
                              <button key={c.id} onClick={() => { setSelectedChildId(c.id); setSubDropdownOpen(false) }}
                                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${selectedChildId === c.id ? 'bg-brand-50' : ''}`}>
                                {c.title || '无标题'}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <p className="text-sm text-gray-700 mb-3">📖 预览模式 — 子会话对话流</p>
                      <div className="text-sm text-gray-400">
                        选择子会话后，此处将展示完整的对话记录。<br/>
                        功能开发中，敬请期待。
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-gray-400 text-sm">加载中...</p>
            )}
          </div>
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
      <div className="flex-1 flex flex-col">
      {/* Full list header & table */}
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
                  <div className="px-2 py-1 border-t mt-1">
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
            <button onClick={() => setShowBatchDelete(true)} className="text-red-600 hover:text-red-800">🗑 删除所选</button>
            <button onClick={batchExport} className="text-blue-600 hover:text-blue-800">⬇ 导出所选</button>
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
                  <td className="px-4 py-3 text-right text-gray-600">{((session as any).childCount ?? 0).toLocaleString()}</td>
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
    </div>
  )
}

export default Sessions
