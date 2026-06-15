import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router'
import type {
  DatabaseStats,
  TokenStats,
  ToolRanking,
  SkillUsage,
  TimeRange,
  TokenGroupDataPoint,
  ModelRankingItem,
  ProviderStatsItem,
  SessionTrendItem,
  CostTrendItem,
  MessageTrendItem,
} from '@shared/types'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { invokeSafe } from '@/lib/ipc'
import {
  MessageSquare,
  Folder,
  Layers,
  DollarSign,
  RefreshCw,
  Sparkles,
  FileCheck,
  Loader2,
  AlertCircle,
  Unplug,
  Download,
  LayoutDashboard,
  Database,
  Trash2,
  FileText,
  Heart,
} from 'lucide-react'
import { useToast } from '../../hooks/useToast'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts'
import StatCard from '@/components/StatCard'
import PageHeader from '@/components/PageHeader'
import TooltipHint from '@/components/TooltipHint'
import { formatBytes, formatNumber } from '@/lib/format'

// ── Color palette ──────────────────────────────────────────────────
const TOKEN_COLORS = ['#3b82f6', '#10b981', '#8b5cf6']
const TOOL_BAR_COLOR = '#3b82f6'
const SKILL_COLORS = [
  '#8b5cf6', '#6366f1', '#a78bfa', '#c4b5fd',
  '#7c3aed', '#5b21b6', '#4c1d95', '#ddd6fe',
  '#6d28d9', '#4f46e5',
]

// ── Time range presets ─────────────────────────────────────────────
type TimePreset = 'all' | 7 | 30 | 90 | 'custom'
type GroupBy = 'day' | 'week' | 'month'
type DashboardTab = 'overview' | 'stats' | 'trends'

const DASHBOARD_TABS: { key: DashboardTab; label: string; icon: string }[] = [
  { key: 'overview', label: '概览', icon: '📋' },
  { key: 'stats', label: '统计', icon: '📊' },
  { key: 'trends', label: '趋势', icon: '📈' },
]

// 本地日期格式 YYYY-MM-DD（避免 toISOString() 的 UTC 偏移）
function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function computeTimeRange(days: TimePreset, start?: string, end?: string): TimeRange | undefined {
  if (days === 'all') return undefined
  if (days === 'custom' && start && end) return { startDate: start, endDate: end }
  if (days === 'custom') return undefined
  const endDate = toLocalDateString(new Date())
  const startDate = toLocalDateString(new Date(Date.now() - days * 24 * 60 * 60 * 1000))
  return { startDate, endDate }
}

// 计算"上期"时间范围 — 与当前 timeRange 等长且紧邻的前一个区间
// 例如：当前 5/14 ~ 6/13（30 天）→ 上期 4/14 ~ 5/13（30 天）
function computePrevTimeRange(current: TimeRange | undefined): TimeRange | undefined {
  if (!current) return undefined
  const [y1, m1, d1] = current.startDate.split('-').map(Number)
  const [y2, m2, d2] = current.endDate.split('-').map(Number)
  const start = new Date(y1, m1 - 1, d1)
  const end = new Date(y2, m2 - 1, d2)
  const ms = end.getTime() - start.getTime()
  if (ms <= 0) return undefined
  const prevEnd = new Date(start.getTime() - 24 * 60 * 60 * 1000) // 上期 endDate = 当前 startDate - 1 天
  const prevStart = new Date(prevEnd.getTime() - ms)
  return {
    startDate: toLocalDateString(prevStart),
    endDate: toLocalDateString(prevEnd),
  }
}

// ── Module-level cache ─────────────────────────────────────────────
interface DashboardCache {
  dbStats: DatabaseStats | null
  tokenStats: TokenStats | null
  tokenGroupData: TokenGroupDataPoint[]
  toolRanking: ToolRanking[]
  skillUsage: SkillUsage[]
  dbHealth: { pageCount: number; freelistPages: number; walSize: number; ok: boolean } | null
  timeRange: TimeRange | undefined
  timePreset: TimePreset
  groupBy: GroupBy
  modelRanking: ModelRankingItem[]
  providerStats: ProviderStatsItem[]
  sessionTrend: SessionTrendItem[]
  costTrend: CostTrendItem[]
  messageTrend: MessageTrendItem[]
}

let dashboardCache: DashboardCache | null = null

// ── Dashboard ──────────────────────────────────────────────────────
function Dashboard() {
  const navigate = useNavigate()
  const { addToast } = useToast()
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(dashboardCache?.dbStats ?? null)
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(dashboardCache?.tokenStats ?? null)
  const [toolRanking, setToolRanking] = useState<ToolRanking[]>(dashboardCache?.toolRanking ?? [])
  const [skillUsage, setSkillUsage] = useState<SkillUsage[]>(dashboardCache?.skillUsage ?? [])
  const [tokenGroupData, setTokenGroupData] = useState<TokenGroupDataPoint[]>(dashboardCache?.tokenGroupData ?? [])
  const [modelRanking, setModelRanking] = useState<ModelRankingItem[]>(dashboardCache?.modelRanking ?? [])
  const [providerStats, setProviderStats] = useState<ProviderStatsItem[]>(dashboardCache?.providerStats ?? [])
  const [sessionTrend, setSessionTrend] = useState<SessionTrendItem[]>(dashboardCache?.sessionTrend ?? [])
  const [costTrend, setCostTrend] = useState<CostTrendItem[]>(dashboardCache?.costTrend ?? [])
  const [messageTrend, setMessageTrend] = useState<MessageTrendItem[]>(dashboardCache?.messageTrend ?? [])

  // 对比上期数据（cost / session / message 三条趋势图共用同一开关）
  const [prevSessionTrend, setPrevSessionTrend] = useState<SessionTrendItem[]>([])
  const [prevCostTrend, setPrevCostTrend] = useState<CostTrendItem[]>([])
  const [prevMessageTrend, setPrevMessageTrend] = useState<MessageTrendItem[]>([])
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('overview')

  // Time range & grouping state
  const [timePreset, setTimePreset] = useState<TimePreset>(dashboardCache?.timePreset ?? 30)
  const [timeRange, setTimeRange] = useState<TimeRange | undefined>(dashboardCache?.timeRange ?? computeTimeRange(dashboardCache?.timePreset ?? 30))
  const [groupBy, setGroupBy] = useState<GroupBy>(dashboardCache?.groupBy ?? 'day')
  const [showSessionCompare, setShowSessionCompare] = useState(true)
  const [showCostCompare, setShowCostCompare] = useState(true)
  const [showMessageCompare, setShowMessageCompare] = useState(true)
  const [customStart, setCustomStart] = useState<string>('')
  const [customEnd, setCustomEnd] = useState<string>('')

  // 根会话趋势过滤（仅当 dashboardTab === 'trends' 时生效）
  const [rootOnly, setRootOnly] = useState(false)

  const [connected, setConnected] = useState(!!dashboardCache)
  const [dbPath, setDbPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(!dashboardCache)
  const [fastLoading, setFastLoading] = useState(!dashboardCache?.dbStats)
  const [slowLoading, setSlowLoading] = useState(!dashboardCache?.toolRanking?.length && !dashboardCache?.skillUsage?.length)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [dbHealth, setDbHealth] = useState<{ pageCount: number; freelistPages: number; walSize: number; ok: boolean } | null>(dashboardCache?.dbHealth ?? null)

  // ── 修复问题 2：切回 Dashboard 时若 dbHealth 缺失则主动恢复 ──────────
  // 原因：路由切换 + Vite HMR 可能让模块级 dashboardCache 重新初始化，
  //      导致组件重新挂载时 useState 拿到的是 null。
  //      通过此 effect 重新拉一次 health check 即可。
  useEffect(() => {
    if (connected && dbHealth === null && !fastLoading) {
      invokeSafe<{ ok: boolean; pageCount: number; freelistPages: number; walSize: number }>(IPC_CHANNELS.DATABASE_HEALTH)
        .then((health) => {
          if (health) {
            const next = {
              pageCount: health.pageCount,
              freelistPages: health.freelistPages,
              walSize: health.walSize ?? 0,
              ok: health.ok,
            }
            setDbHealth(next)
            if (dashboardCache) {
              dashboardCache = { ...dashboardCache, dbHealth: next }
            }
          }
        })
        .catch(() => { /* 保持 null，UI 显示"不可用"提示 */ })
    }
  }, [connected, dbHealth, fastLoading])

  // ── Export helpers ────────────────────────────────────────────────
  function exportCSV(data: object[], filename: string) {
    if (!data.length) return
    const first = data[0] as Record<string, unknown>
    const header = Object.keys(first).join(',')
    const rows = data.map(r => Object.values(r as Record<string, unknown>).join(',')).join('\n')
    window.electronAPI.saveFile(header + '\n' + rows, filename).then((res) => {
      if (res.success && res.data?.success) addToast(`${filename} 已保存`, 'success')
    })
  }
  function exportJSON(data: unknown, filename: string) {
    window.electronAPI.saveFile(JSON.stringify(data, null, 2), filename).then((res) => {
      if (res.success && res.data?.success) addToast(`${filename} 已保存`, 'success')
    })
  }

  const hasLoadedRef = useRef(!!dashboardCache)

  // ── Load fast data (overview + tokens + health) ─────────────────────
  const loadFastData = useCallback(async (tr: TimeRange | undefined, gb: GroupBy) => {
    setFastLoading(true)
    const [stats, tokens, groupData, health] = await Promise.all([
      invokeSafe<DatabaseStats>(IPC_CHANNELS.DASHBOARD_OVERVIEW, tr),
      invokeSafe<TokenStats>(IPC_CHANNELS.DASHBOARD_TOKENS, tr),         // no groupBy → TokenStats
      invokeSafe<TokenGroupDataPoint[]>(IPC_CHANNELS.DASHBOARD_TOKENS, tr, gb),  // with groupBy → grouped data
      invokeSafe<{ ok: boolean; pageCount: number; freelistPages: number; walSize: number }>(IPC_CHANNELS.DATABASE_HEALTH),
    ])
    setDbStats(stats)
    setTokenStats(tokens)
    setTokenGroupData(groupData)
    let nextHealth: { pageCount: number; freelistPages: number; walSize: number; ok: boolean } | null = null
    if (health) {
      nextHealth = {
        pageCount: health.pageCount,
        freelistPages: health.freelistPages,
        walSize: health.walSize ?? 0,
        ok: health.ok,
      }
      setDbHealth(nextHealth)
    }
    setFastLoading(false)
    return { stats, tokens, groupData, dbHealth: nextHealth }
  }, [])

  // ── Load slow data (tools + skills + 3 new trends) ──────────────
  const loadSlowData = useCallback(async (tr: TimeRange | undefined) => {
    setSlowLoading(true)
    const [tools, skills, models, providers, sessionTr, costTr, msgTr] = await Promise.all([
      invokeSafe<ToolRanking[]>(IPC_CHANNELS.DASHBOARD_TOOL_RANKING, tr),
      invokeSafe<SkillUsage[]>(IPC_CHANNELS.DASHBOARD_SKILL_USAGE, tr),
      invokeSafe<ModelRankingItem[]>(IPC_CHANNELS.DASHBOARD_MODEL_RANKING, tr).catch(() => [] as ModelRankingItem[]),
      invokeSafe<ProviderStatsItem[]>(IPC_CHANNELS.DASHBOARD_PROVIDER_STATS, tr).catch(() => [] as ProviderStatsItem[]),
      invokeSafe<SessionTrendItem[]>(IPC_CHANNELS.DASHBOARD_SESSION_TREND, tr, rootOnly).catch(() => [] as SessionTrendItem[]),
      invokeSafe<CostTrendItem[]>(IPC_CHANNELS.DASHBOARD_COST_TREND, tr).catch(() => [] as CostTrendItem[]),
      invokeSafe<MessageTrendItem[]>(IPC_CHANNELS.DASHBOARD_MESSAGE_TREND, tr).catch(() => [] as MessageTrendItem[]),
    ])
    setToolRanking(tools ?? [])
    setSkillUsage(skills ?? [])
    setModelRanking(models ?? [])
    setProviderStats(providers ?? [])
    setSessionTrend(sessionTr ?? [])
    setCostTrend(costTr ?? [])
    setMessageTrend(msgTr ?? [])
    setSlowLoading(false)
    return {
      tools: tools ?? [],
      skills: skills ?? [],
      models: models ?? [],
      providers: providers ?? [],
      sessionTrend: sessionTr ?? [],
      costTrend: costTr ?? [],
      messageTrend: msgTr ?? [],
    }
  }, [rootOnly])

  // ── Load all data with async groups ──────────────────────────────
  const loadAllData = useCallback(async (forceRefresh = false) => {
    // Use cache if available and not forcing refresh
    if (dashboardCache && !forceRefresh) {
      setDbStats(dashboardCache.dbStats)
      setTokenStats(dashboardCache.tokenStats)
      setToolRanking(dashboardCache.toolRanking)
      setSkillUsage(dashboardCache.skillUsage)
      setTokenGroupData(dashboardCache.tokenGroupData)
      setDbHealth(dashboardCache.dbHealth)
      setTimeRange(dashboardCache.timeRange)
      setTimePreset(dashboardCache.timePreset)
      setGroupBy(dashboardCache.groupBy)
      setModelRanking(dashboardCache.modelRanking ?? [])
      setProviderStats(dashboardCache.providerStats ?? [])
      setFastLoading(false)
      setSlowLoading(false)
      // Don't return — still refresh Route B data below
    }

    setError(null)
    try {
      // Run fast and slow data loading in parallel to prevent UI freeze
      const [fastResult, slowResult] = await Promise.all([
        loadFastData(timeRange, groupBy),
        loadSlowData(timeRange),
      ])

      // Update cache
      dashboardCache = {
        dbStats: fastResult.stats,
        tokenStats: fastResult.tokens,
        tokenGroupData: fastResult.groupData,
        toolRanking: slowResult.tools,
        skillUsage: slowResult.skills,
        dbHealth: fastResult.dbHealth,
        timeRange,
        timePreset,
        groupBy,
        modelRanking: slowResult.models,
        providerStats: slowResult.providers,
        sessionTrend: slowResult.sessionTrend,
        costTrend: slowResult.costTrend,
        messageTrend: slowResult.messageTrend,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to load dashboard data')
    }
  }, [loadFastData, loadSlowData, timeRange, groupBy, timePreset])

  // ── Refresh handler (force reload) ───────────────────────────────
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [fastResult, slowResult] = await Promise.all([
        loadFastData(timeRange, groupBy),
        loadSlowData(timeRange),
      ])
      dashboardCache = {
        dbStats: fastResult.stats,
        tokenStats: fastResult.tokens,
        tokenGroupData: fastResult.groupData,
        toolRanking: slowResult.tools,
        skillUsage: slowResult.skills,
        dbHealth: fastResult.dbHealth,
        timeRange,
        timePreset,
        groupBy,
        modelRanking: slowResult.models,
        providerStats: slowResult.providers,
        sessionTrend: slowResult.sessionTrend,
        costTrend: slowResult.costTrend,
        messageTrend: slowResult.messageTrend,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to refresh dashboard data')
    } finally {
      setRefreshing(false)
    }
  }, [loadFastData, loadSlowData, timeRange, groupBy, timePreset])

  // ── Initial connection check ─────────────────────────────────────
  useEffect(() => {
    if (hasLoadedRef.current) return
    async function init() {
      // If cache exists, use it directly without health check
      if (dashboardCache) {
        setDbStats(dashboardCache.dbStats)
        setTokenStats(dashboardCache.tokenStats)
        setToolRanking(dashboardCache.toolRanking)
        setSkillUsage(dashboardCache.skillUsage)
        setDbHealth(dashboardCache.dbHealth)
        setTimeRange(dashboardCache.timeRange)
        setTimePreset(dashboardCache.timePreset)
        setGroupBy(dashboardCache.groupBy)
        setModelRanking(dashboardCache.modelRanking ?? [])
        setProviderStats(dashboardCache.providerStats ?? [])
        setConnected(true)
        setLoading(false)
        setFastLoading(false)
        setSlowLoading(false)
        hasLoadedRef.current = true
        return
      }
      // No cache — do health check then load data
      try {
        const health = await invokeSafe<{ ok: boolean }>(IPC_CHANNELS.DATABASE_HEALTH)
        if (health.ok) {
          setConnected(true)
          await loadAllData()
        } else {
          setConnected(false)
        }
      } catch {
        setConnected(false)
      } finally {
        setLoading(false)
        hasLoadedRef.current = true
      }
    }
    init()
  }, [loadAllData])

  // ── Connect to a database ────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    try {
      const filePath = await invokeSafe<string>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      const result = await invokeSafe<{ path: string }>(IPC_CHANNELS.DATABASE_OPEN, filePath)
      setConnected(true)
      setDbPath(result.path ?? filePath)
      dashboardCache = null
      await loadAllData(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [loadAllData])

  // ── Vacuum ───────────────────────────────────────────────────────
  const handleVacuum = useCallback(async () => {
    setActionLoading('vacuum')
    try {
      const result = await invokeSafe<{ before: number; after: number; freed: number }>(IPC_CHANNELS.DATABASE_VACUUM)
      setToast({ message: `VACUUM 完成! 释放空间: ${formatBytes(result.freed)}`, type: 'success' })
      setTimeout(() => setToast(null), 3000)
      dashboardCache = null
      await loadAllData(true)
    } catch (err) {
      setToast({ message: `VACUUM 失败: ${(err as Error).message}`, type: 'error' })
      setTimeout(() => setToast(null), 3000)
    } finally {
      setActionLoading(null)
    }
  }, [loadAllData])

  // ── WAL Checkpoint ───────────────────────────────────────────────
  const handleCheckpoint = useCallback(async () => {
    setActionLoading('checkpoint')
    try {
      await invokeSafe(IPC_CHANNELS.DATABASE_CHECKPOINT)
      setToast({ message: 'WAL Checkpoint 完成!', type: 'success' })
      setTimeout(() => setToast(null), 3000)
      dashboardCache = null
      await loadAllData(true)
    } catch (err) {
      setToast({ message: `Checkpoint 失败: ${(err as Error).message}`, type: 'error' })
      setTimeout(() => setToast(null), 3000)
    } finally {
      setActionLoading(null)
    }
  }, [loadAllData])

  // ── Trend data with comparison ──────────────────────────────────
  // 趋势模块已移除"数据库增长趋势"图（与"会话创建趋势"重复、size 趋势意义不大）
  // 原来这里的 trendData / previousTrendData / mergedTrendData 全部删除

  // 合并"会话/成本/消息活跃度"当前+上期（按索引对齐）
  const mergedSessionTrend = useMemo(() => {
    if (prevSessionTrend.length === 0) return sessionTrend
    return sessionTrend.map((cur, i) => {
      const prev = prevSessionTrend[i]
      return {
        ...cur,
        prevCount: prev?.count ?? 0,
      }
    })
  }, [sessionTrend, prevSessionTrend])

  const mergedCostTrend = useMemo(() => {
    if (prevCostTrend.length === 0) return costTrend
    return costTrend.map((cur, i) => {
      const prev = prevCostTrend[i]
      return {
        ...cur,
        prevTotalCost: prev?.totalCost ?? 0,
      }
    })
  }, [costTrend, prevCostTrend])

  const mergedMessageTrend = useMemo(() => {
    if (prevMessageTrend.length === 0) return messageTrend
    return messageTrend.map((cur, i) => {
      const prev = prevMessageTrend[i]
      return {
        ...cur,
        prevCount: prev?.count ?? 0,
      }
    })
  }, [messageTrend, prevMessageTrend])

  // 上期日期范围（用于在图例/副标题标注，避免与当前期日期混淆）
  const prevRangeLabel = useMemo(() => {
    const prevTR = computePrevTimeRange(timeRange)
    if (!prevTR) return ''
    const fmt = (d: string) => d.slice(5) // MM-DD
    return `${fmt(prevTR.startDate)}~${fmt(prevTR.endDate)}`
  }, [timeRange])

  // ── Time range change handler ──────────────────────────────────
  const handleTimePresetChange = useCallback(async (days: TimePreset) => {
    setTimePreset(days)
    const tr = computeTimeRange(days, customStart, customEnd)
    setTimeRange(tr)
    dashboardCache = null
    // Directly load with new params (state updates are async, so pass computed values)
    setFastLoading(true)
    setSlowLoading(true)
    setError(null)
    try {
      const [fastResult, slowResult] = await Promise.all([
        loadFastData(tr, groupBy),
        loadSlowData(tr),
      ])
      dashboardCache = {
        dbStats: fastResult.stats,
        tokenStats: fastResult.tokens,
        tokenGroupData: fastResult.groupData,
        toolRanking: slowResult.tools,
        skillUsage: slowResult.skills,
        dbHealth: fastResult.dbHealth,
        timeRange: tr,
        timePreset: days,
        groupBy,
        modelRanking: slowResult.models,
        providerStats: slowResult.providers,
        sessionTrend: slowResult.sessionTrend,
        costTrend: slowResult.costTrend,
        messageTrend: slowResult.messageTrend,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to load dashboard data')
    }
  }, [loadFastData, loadSlowData, groupBy, customStart, customEnd])

  // ── GroupBy change handler ─────────────────────────────────────
  const handleGroupByChange = useCallback(async (gb: GroupBy) => {
    setGroupBy(gb)
    dashboardCache = null
    setFastLoading(true)
    setSlowLoading(true)
    setError(null)
    try {
      const [fastResult, slowResult] = await Promise.all([
        loadFastData(timeRange, gb),
        loadSlowData(timeRange),
      ])
      dashboardCache = {
        dbStats: fastResult.stats,
        tokenStats: fastResult.tokens,
        tokenGroupData: fastResult.groupData,
        toolRanking: slowResult.tools,
        skillUsage: slowResult.skills,
        dbHealth: fastResult.dbHealth,
        timeRange,
        timePreset,
        groupBy: gb,
        modelRanking: slowResult.models,
        providerStats: slowResult.providers,
        sessionTrend: slowResult.sessionTrend,
        costTrend: slowResult.costTrend,
        messageTrend: slowResult.messageTrend,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to load dashboard data')
    }
  }, [loadFastData, loadSlowData, timeRange, timePreset])

  // ── 对比上期：拉取 session/cost/message 三个趋势的上期数据 ─────
  const anyNewCompareOn = showSessionCompare || showCostCompare || showMessageCompare
  useEffect(() => {
    if (!anyNewCompareOn || dashboardTab !== 'trends') {
      // 全部关闭 或 离开趋势 Tab 时清空，避免陈旧数据
      setPrevSessionTrend([])
      setPrevCostTrend([])
      setPrevMessageTrend([])
      return
    }
    const prevTR = computePrevTimeRange(timeRange)
    if (!prevTR) {
      setPrevSessionTrend([])
      setPrevCostTrend([])
      setPrevMessageTrend([])
      return
    }
    let cancelled = false
    Promise.all([
      invokeSafe<SessionTrendItem[]>(IPC_CHANNELS.DASHBOARD_SESSION_TREND, prevTR, rootOnly).catch(() => [] as SessionTrendItem[]),
      invokeSafe<CostTrendItem[]>(IPC_CHANNELS.DASHBOARD_COST_TREND, prevTR).catch(() => [] as CostTrendItem[]),
      invokeSafe<MessageTrendItem[]>(IPC_CHANNELS.DASHBOARD_MESSAGE_TREND, prevTR).catch(() => [] as MessageTrendItem[]),
    ]).then(([s, c, m]) => {
      if (cancelled) return
      setPrevSessionTrend(s ?? [])
      setPrevCostTrend(c ?? [])
      setPrevMessageTrend(m ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [anyNewCompareOn, dashboardTab, timeRange, rootOnly])

  // ── Not connected view ───────────────────────────────────────────
  if (!connected && !loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <Unplug size={48} className="mx-auto text-gray-300 mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">No Database Connected</h2>
          <p className="text-gray-500 mb-6">
            Select an OpenCode SQLite database to get started.
          </p>
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700 text-left">
              {error}
            </div>
          )}
          <button
            onClick={handleConnect}
            className="px-5 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors font-medium"
          >
            Connect Database
          </button>
        </div>
      </div>
    )
  }

  // ── Error view ───────────────────────────────────────────────────
  if (error && !dbStats) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Failed to Load Data</h2>
          <p className="text-gray-500 mb-4 text-sm">{error}</p>
          <button
            onClick={() => loadAllData(true)}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // ── Token distribution data for pie chart ────────────────────────
  const tokenPieData = tokenStats
    ? [
        { name: '输入Token', value: tokenStats.inputTokens },
        { name: '输出Token', value: tokenStats.outputTokens },
        { name: '推理Token', value: tokenStats.reasoningTokens },
      ].filter((d) => d.value > 0)
    : []

  // ── Tool ranking top 10 ──────────────────────────────────────────
  const toolData = toolRanking.slice(0, 10).map((t) => ({
    name: t.toolName.length > 20 ? t.toolName.slice(0, 18) + '...' : t.toolName,
    count: t.count,
  }))

  // ── Skill usage data ─────────────────────────────────────────────
  const skillData = skillUsage.slice(0, 10).map((s) => ({
    name: s.skillName.length > 16 ? s.skillName.slice(0, 14) + '...' : s.skillName,
    count: s.count,
  }))

  return (
    <div className="p-4 space-y-4 max-w-[1400px] mx-auto">
      {/* ── Toast notification ──────────────────────────────────── */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-opacity ${
            toast.type === 'success'
              ? 'bg-green-500 text-white'
              : 'bg-red-500 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
      {/* ── Header ──────────────────────────────────────────────── */}
      <PageHeader
        icon={<LayoutDashboard size={24} />}
        title="仪表盘"
        description={dbPath || undefined}
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-green-600 border border-green-300 rounded-md hover:bg-green-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              刷新
            </button>
          </div>
        }
      />

      {/* ── Sub Tab Bar ──────────────────────────────────────────── */}
      <div className="flex border-b border-gray-200 bg-white px-2 gap-0 -mt-2 mb-4 rounded-md">
        {DASHBOARD_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setDashboardTab(tab.key)}
            className={`px-4 py-2 text-sm border-b-2 -mb-[1px] whitespace-nowrap transition-colors ${
              dashboardTab === tab.key
                ? 'border-brand-500 text-brand-700 font-medium'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <span className="mr-1.5">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── 全局时间范围（4 Tab 共享） ─────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 font-medium mb-2">⏱ 时间范围</p>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
            {(['all', 7, 30, 90, 'custom'] as TimePreset[]).map((days) => (
              <button
                key={days}
                onClick={() => handleTimePresetChange(days)}
                className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                  timePreset === days
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {days === 'all' ? '全部' : days === 'custom' ? '自定义' : `${days}天`}
              </button>
            ))}
          </div>
        </div>
        {timePreset === 'custom' && (
          <div className="flex items-center gap-3 mt-2">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="text-sm text-gray-400">至</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <button
              onClick={() => handleTimePresetChange('custom')}
              disabled={!customStart || !customEnd}
              className="px-3 py-1.5 text-sm bg-brand-600 text-white rounded-md hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              应用
            </button>
          </div>
        )}
      </div>

      {/* ── Tab 内容 ──────────────────────────────────────────────── */}
      {dashboardTab === 'overview' && (
        <div className="space-y-6">
          {/* ── 上部：左右结构 ── */}
          <div className="grid grid-cols-2 gap-6 items-stretch">
            {/* 左：时段统计 2×2 卡片 */}
            <div className="flex flex-col">
              <p className="text-xs text-gray-400 font-medium mb-2">📈 时段统计
                {tokenStats && <button onClick={() => exportJSON(tokenStats, 'token-stats.json')} className="ml-2 text-brand-500 hover:text-brand-700" title="导出 JSON"><Download size={12} /></button>}
              </p>
              {fastLoading && !tokenStats ? (
                <div className="grid grid-cols-2 gap-4 flex-1">
                  {[1,2,3,4].map(i => (
                    <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse">
                      <div className="h-3 bg-gray-200 rounded w-16 mb-3" />
                      <div className="h-6 bg-gray-200 rounded w-24" />
                    </div>
                  ))}
                </div>
              ) : dbStats && tokenStats ? (
                <div className="grid grid-cols-2 gap-4 flex-1 grid-rows-2">
                  <StatCard
                    label="根/子会话数"
                    value={`${formatNumber(dbStats.rootSessionCount)}/${formatNumber(dbStats.childSessionCount)}`}
                    icon={<MessageSquare size={20} />}
                  />
                  <StatCard
                    label="项目数"
                    value={formatNumber(dbStats.projectCount)}
                    icon={<Folder size={20} />}
                  />
                  <StatCard
                    label="Part行数"
                    value={formatNumber(dbStats.partCount)}
                    icon={<Layers size={20} />}
                  />
                  <StatCard
                    label="估算成本"
                    value={`$${(tokenStats.estimatedCost ?? 0).toFixed(2)}`}
                    icon={<DollarSign size={20} />}
                  />
                </div>
              ) : null}
            </div>

            {/* 右：Token 饼图统计（从趋势 Tab 移过来） */}
            <div className="flex flex-col">
              <p className="text-xs text-gray-400 font-medium mb-2">💰 Token 统计</p>
              <div className="bg-white rounded-lg border border-gray-200 p-5 flex-1">
                {tokenStats && tokenPieData.length > 0 ? (
                  <div className="flex items-center gap-6">
                    <div className="w-40 h-40 flex-shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={tokenPieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={35}
                            outerRadius={65}
                            paddingAngle={2}
                            dataKey="value"
                            stroke="none"
                            onClick={() => {
                              if (timeRange) navigate(`/sessions?start=${timeRange.startDate}&end=${timeRange.endDate}`)
                            }}
                            style={{ cursor: 'pointer' }}
                          >
                            {tokenPieData.map((_entry, index) => (
                              <Cell key={`cell-${index}`} fill={TOKEN_COLORS[index % TOKEN_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={(value: number) => formatNumber(value)}
                            contentStyle={{
                              fontSize: '12px',
                              borderRadius: '8px',
                              border: '1px solid #e5e7eb',
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex-1 space-y-3 min-w-0">
                      <TokenMetricRow
                        label="输入Token"
                        value={formatNumber(tokenStats.inputTokens)}
                        color="bg-brand-500"
                      />
                      <TokenMetricRow
                        label="输出Token"
                        value={formatNumber(tokenStats.outputTokens)}
                        color="bg-emerald-500"
                      />
                      <TokenMetricRow
                        label="推理Token"
                        value={formatNumber(tokenStats.reasoningTokens)}
                        color="bg-violet-500"
                      />
                      <div className="border-t border-gray-100 pt-2 mt-2">
                        <TokenMetricRow
                          label="缓存复用率"
                          value={`${(tokenStats.cacheReuseRate ?? 0).toFixed(1)}%`}
                          color="bg-amber-500"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">暂无Token数据</p>
                )}
              </div>
            </div>
          </div>

          {/* ── 下部：数据库概览（与时间范围无关） ── */}
          <div>
            <p className="text-xs text-gray-400 font-medium mb-2">🗄 数据库概览
              {dbStats && <button onClick={() => exportJSON(dbStats, 'db-overview.json')} className="ml-2 text-brand-500 hover:text-brand-700" title="导出 JSON"><Download size={12} /></button>}
            </p>
            {fastLoading && !dbStats ? (
              <div className="grid grid-cols-4 gap-4">
                {[1,2,3,4].map(i => (
                  <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 h-24 animate-pulse">
                    <div className="h-3 bg-gray-200 rounded w-16 mb-3" />
                    <div className="h-6 bg-gray-200 rounded w-24" />
                  </div>
                ))}
              </div>
            ) : dbStats ? (
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-4">
                  <StatCard
                    label="总大小"
                    value={formatBytes(dbStats.dbSize)}
                    icon={<Database size={20} />}
                  />
                  <StatCard
                    label="可回收碎片"
                    value={formatBytes(dbStats.freelistSize)}
                    icon={<Trash2 size={20} />}
                  />
                  <StatCard
                    label="WAL日志"
                    value={formatBytes(dbStats.walSize)}
                    icon={<FileText size={20} />}
                  />
                  <StatCard
                    label="健康状态"
                    value={dbHealth ? formatNumber(dbHealth.pageCount) : '-'}
                    icon={<Heart size={20} />}
                  >
                    {dbHealth && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        {dbHealth.freelistPages} 碎片页
                      </p>
                    )}
                  </StatCard>
                </div>
                {dbHealth && (
                  <div className="bg-white rounded-lg border border-gray-200 p-3 flex gap-2 items-center flex-wrap">
                    <div className="flex items-center">
                      <button
                        onClick={handleVacuum}
                        disabled={actionLoading !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-brand-600 border border-brand-300 rounded-md hover:bg-brand-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {actionLoading === 'vacuum' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                        {actionLoading === 'vacuum' ? '执行中...' : '一键 VACUUM'}
                      </button>
                      <TooltipHint text={'清理数据库碎片，回收已删除数据占用的空间\n\n适用场景：删除会话/消息后，数据库文件未变小时'} />
                    </div>
                    <div className="flex items-center">
                      <button
                        onClick={handleCheckpoint}
                        disabled={actionLoading !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-amber-600 border border-amber-300 rounded-md hover:bg-amber-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {actionLoading === 'checkpoint' ? <Loader2 size={14} className="animate-spin" /> : <FileCheck size={14} />}
                        {actionLoading === 'checkpoint' ? '执行中...' : 'WAL Checkpoint'}
                      </button>
                      <TooltipHint text={'将待写入的变更合并到主数据库\n\n适用场景：备份前执行，或 WAL 文件过大时'} />
                    </div>
                  </div>
                )}
                {!dbHealth && (
                  <p className="text-sm text-gray-400 text-center py-4 bg-white rounded-lg border border-gray-200">数据库状态不可用</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 text-center py-8">数据库状态不可用</p>
            )}
          </div>
        </div>
      )}

      {dashboardTab === 'trends' && (
        <div className="grid grid-cols-2 gap-6 items-stretch">
          {/* Token 折线图（饼图已移到概览） */}
          <div className="h-full flex flex-col">
            <p className="text-xs text-gray-400 font-medium mb-2">📊 Token 趋势
              {tokenGroupData.length > 0 && <button onClick={() => exportCSV(tokenGroupData, 'token-trend.csv')} className="ml-2 text-emerald-500 hover:text-emerald-700" title="导出 Token 趋势 CSV"><Download size={12} /></button>}
            </p>
            <div className="bg-white rounded-lg border border-gray-200 p-5 relative flex-1 flex flex-col">
              {fastLoading && !tokenGroupData.length && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60 rounded-lg z-10">
                  <Loader2 size={20} className="text-brand-400 animate-spin" />
                </div>
              )}
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-gray-700">Token 趋势</h3>
                <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
                  {(['day', 'week', 'month'] as GroupBy[]).map((g) => (
                    <button
                      key={g}
                      onClick={() => handleGroupByChange(g)}
                      className={`px-3 py-1 text-xs font-medium transition-colors ${
                        groupBy === g
                          ? 'bg-brand-500 text-white'
                          : 'bg-white text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      {g === 'day' ? '天' : g === 'week' ? '周' : '月'}
                    </button>
                  ))}
                </div>
              </div>
              {tokenGroupData.length > 0 ? (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={tokenGroupData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="period" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }}
                        formatter={(value: number) => formatNumber(value)}
                      />
                      <Line type="monotone" dataKey="inputTokens" name="输入" stroke="#3B82F6" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="outputTokens" name="输出" stroke="#10B981" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="reasoningTokens" name="推理" stroke="#8B5CF6" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无Token趋势数据</p>
              )}
            </div>
          </div>

          {/* 成本趋势 (右上) */}
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium">💰 成本趋势
                {costTrend.length > 0 && <button onClick={() => exportCSV(costTrend, 'cost-trend.csv')} className="ml-2 text-emerald-500 hover:text-emerald-700" title="导出 CSV"><Download size={12} /></button>}
                {showCostCompare && prevCostTrend.length > 0 && prevRangeLabel && (
                  <span className="ml-2 text-xs text-gray-400 italic">（虚线：上期 {prevRangeLabel}）</span>
                )}
              </p>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500">对比上期</span>
                <input
                  type="checkbox"
                  checked={showCostCompare}
                  onChange={(e) => setShowCostCompare(e.target.checked)}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
              </label>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-5 flex-1 flex flex-col">
              {costTrend.length > 0 ? (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={mergedCostTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <YAxis tick={{ fontSize: 11 }} stroke="#9ca3af" tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
                      <Tooltip
                        contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }}
                        labelStyle={{ fontWeight: 600 }}
                        formatter={(v: number, name: string) => [`$${v.toFixed(2)}`, name === 'totalCost' ? '成本' : name === 'prevTotalCost' ? '上期成本' : name]}
                      />
                      <Line type="monotone" dataKey="totalCost" name="成本" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                      {showCostCompare && prevCostTrend.length > 0 && (
                        <Line
                          type="monotone"
                          dataKey="prevTotalCost"
                          name="上期成本"
                          stroke="#9ca3af"
                          strokeWidth={1.5}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 2 }}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无数据</p>
              )}
            </div>
          </div>

          {/* 会话创建趋势 (左下) */}
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium">
                📅 会话创建趋势
                <button
                  onClick={() => setRootOnly(!rootOnly)}
                  className={`ml-2 px-2 py-0.5 text-xs rounded-full border transition-colors ${
                    rootOnly
                      ? 'bg-brand-100 text-brand-700 border-brand-300'
                      : 'text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                  title="切换根会话过滤（仅统计 parent_id IS NULL 的会话）"
                >
                  {rootOnly ? '仅根会话' : '全部会话'}
                </button>
                {sessionTrend.length > 0 && (
                  <button
                    onClick={() => exportCSV(sessionTrend, 'session-trend.csv')}
                    className="ml-2 text-brand-500 hover:text-brand-700"
                    title="导出 CSV"
                  >
                    <Download size={12} />
                  </button>
                )}
                {showSessionCompare && prevSessionTrend.length > 0 && prevRangeLabel && (
                  <span className="ml-2 text-xs text-gray-400 italic">（虚线：上期 {prevRangeLabel}）</span>
                )}
              </p>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500">对比上期</span>
                <input
                  type="checkbox"
                  checked={showSessionCompare}
                  onChange={(e) => setShowSessionCompare(e.target.checked)}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
              </label>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-5 flex-1 flex flex-col">
              {sessionTrend.length > 0 ? (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={mergedSessionTrend}
                      onClick={(payload) => {
                        if (payload?.activePayload?.length) {
                          const data = payload.activePayload[0].payload
                          if (data.date) navigate(`/sessions?start=${data.date}&end=${data.date}`)
                        }
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <YAxis tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <Tooltip
                        contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }}
                        labelStyle={{ fontWeight: 600 }}
                      />
                      <Line type="monotone" dataKey="count" name="会话数" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                      {showSessionCompare && prevSessionTrend.length > 0 && (
                        <Line type="monotone" dataKey="prevCount" name="上期会话数" stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="5 5" dot={false} activeDot={{ r: 2 }} />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无数据</p>
              )}
            </div>
          </div>

          {/* 消息活跃度趋势 (右下) */}
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium">💬 消息活跃度趋势
                {messageTrend.length > 0 && <button onClick={() => exportCSV(messageTrend, 'message-trend.csv')} className="ml-2 text-violet-500 hover:text-violet-700" title="导出 CSV"><Download size={12} /></button>}
                {showMessageCompare && prevMessageTrend.length > 0 && prevRangeLabel && (
                  <span className="ml-2 text-xs text-gray-400 italic">（虚线：上期 {prevRangeLabel}）</span>
                )}
              </p>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500">对比上期</span>
                <input
                  type="checkbox"
                  checked={showMessageCompare}
                  onChange={(e) => setShowMessageCompare(e.target.checked)}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
              </label>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-5 flex-1 flex flex-col">
              {messageTrend.length > 0 ? (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={mergedMessageTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <YAxis tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <Tooltip
                        contentStyle={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb' }}
                        labelStyle={{ fontWeight: 600 }}
                        formatter={(v: number, name: string) => [v, name === 'count' ? '消息数' : name === 'prevCount' ? '上期消息数' : name]}
                      />
                      <Line type="monotone" dataKey="count" name="消息数" stroke="#8b5cf6" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                      {showMessageCompare && prevMessageTrend.length > 0 && (
                        <Line
                          type="monotone"
                          dataKey="prevCount"
                          name="上期消息数"
                          stroke="#9ca3af"
                          strokeWidth={1.5}
                          strokeDasharray="5 5"
                          dot={false}
                          activeDot={{ r: 2 }}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无数据</p>
              )}
            </div>
          </div>
        </div>
      )}

      {dashboardTab === 'stats' && (
        <div className="space-y-6">
          {/* 上层：工具&技能 */}
          <div>
            <p className="text-xs text-gray-400 font-medium mb-2">🔧 工具 & 技能排行
              <span className="ml-2 inline-flex gap-1">
                {skillData.length > 0 && <button onClick={() => exportCSV(skillData, 'skill-usage.csv')} className="text-violet-500 hover:text-violet-700" title="导出技能使用 CSV"><Download size={12} /></button>}
                {toolData.length > 0 && <button onClick={() => exportCSV(toolData, 'tool-ranking.csv')} className="text-brand-500 hover:text-brand-700" title="导出工具排行 CSV"><Download size={12} /></button>}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-4">
              {/* Skill Usage */}
              <div className="bg-white rounded-lg border border-gray-200 p-5 relative">
                {slowLoading && !skillData.length && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/60 rounded-lg z-10">
                    <Loader2 size={20} className="text-brand-400 animate-spin" />
                  </div>
                )}
                <h3 className="text-sm font-medium text-gray-700 mb-4">技能使用分布</h3>
                {skillData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={skillData} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
                      <XAxis type="number" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={100}
                        tick={{ fontSize: 11 }}
                        stroke="#9ca3af"
                      />
                      <Tooltip
                        contentStyle={{
                          fontSize: '12px',
                          borderRadius: '8px',
                          border: '1px solid #e5e7eb',
                        }}
                      />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={16}>
                        {skillData.map((_entry, index) => (
                          <Cell key={`skill-${index}`} fill={SKILL_COLORS[index % SKILL_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">暂无技能使用数据</p>
                )}
              </div>

              {/* Tool Ranking */}
              <div className="bg-white rounded-lg border border-gray-200 p-5 relative">
                {slowLoading && !toolData.length && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/60 rounded-lg z-10">
                    <Loader2 size={20} className="text-brand-400 animate-spin" />
                  </div>
                )}
                <h3 className="text-sm font-medium text-gray-700 mb-4">工具使用排行 TOP 10</h3>
                {toolData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={toolData} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
                      <XAxis type="number" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={120}
                        tick={{ fontSize: 11 }}
                        stroke="#9ca3af"
                      />
                      <Tooltip
                        contentStyle={{
                          fontSize: '12px',
                          borderRadius: '8px',
                          border: '1px solid #e5e7eb',
                        }}
                      />
                      <Bar dataKey="count" fill={TOOL_BAR_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">暂无工具使用数据</p>
                )}
              </div>
            </div>
          </div>

          {/* 下层：模型&Provider统计 */}
          <div>
            {modelRanking.length > 0 ? (
              <div>
                <p className="text-xs text-gray-400 font-medium mb-2">🤖 模型 & Provider 统计</p>
                <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
                  {(() => {
                    const sorted = modelRanking
                      .slice()
                      .sort((a, b) => b.sessionCount - a.sessionCount)
                      .slice(0, 10)
                    const max = Math.max(...sorted.map(m => m.sessionCount), 1)
                    return sorted.map((m, idx) => {
                      let modelLabel = m.model
                      let providerLabel = ''
                      if (m.model?.startsWith('{')) {
                        try {
                          const p = JSON.parse(m.model)
                          modelLabel = p.id || p.name || m.model
                          providerLabel = p.provider || ''
                        } catch { /* keep raw */ }
                      }
                      const pct = (m.sessionCount / max) * 100
                      return (
                        <div key={`${providerLabel}-${modelLabel}-${idx}`} className="flex items-center gap-2 text-sm min-w-0">
                          <span className="w-6 text-right text-gray-400 text-xs shrink-0">{idx + 1}</span>
                          <span className="w-64 truncate text-gray-700 shrink-0" title={`${providerLabel ? providerLabel + ' / ' : ''}${modelLabel}`}>
                            {providerLabel && <span className="text-gray-500">{providerLabel}</span>}
                            {providerLabel && ' / '}
                            <span className="font-mono">{modelLabel}</span>
                          </span>
                          <div className="flex-1 h-5 bg-gray-100 rounded relative overflow-hidden min-w-0">
                            <div className="h-full bg-gradient-to-r from-brand-400 to-brand-600 rounded" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="w-20 text-right text-gray-600 text-xs font-mono shrink-0">{m.sessionCount.toLocaleString()} 会话</span>
                          <span className="w-24 text-right text-gray-500 text-xs font-mono shrink-0">${m.totalCost.toFixed(2)}</span>
                        </div>
                      )
                    })
                  })()}
                </div>
                {providerStats.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {providerStats.map(p => (
                      <span key={p.provider} className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                        {p.provider}: {p.sessionCount.toLocaleString()} 会话 · ${p.totalCost.toFixed(2)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 text-center py-8">暂无模型数据</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Token metric row sub-component ─────────────────────────────────
function TokenMetricRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${color} flex-shrink-0`} />
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <span className="text-xs font-medium text-gray-800">{value}</span>
    </div>
  )
}

export default Dashboard
