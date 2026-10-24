import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { useNavigate, Link } from 'react-router'
import type {
  DatabaseStats,
  TokenStats,
  ToolRanking,
  SkillUsage,
  TimeRange,
  TokenGroupDataPoint,
  ModelRankingItem,
  ProviderStatsItem,
  ProjectRankingItem,
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
  LayoutDashboard,
  Database,
  Trash2,
  FileText,
  Heart,
  AlertTriangle,
} from 'lucide-react'
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
import SchemaBlockedState from '@/features/datasource/SchemaBlockedState'
import { useSchemaStatus, useOptionalDataSource } from '@/features/datasource/useDataSource'
import { formatBytes, formatNumber, formatLargeNumber, sumTokenTotal } from '@/lib/format'

// ── 统计不可用时的统一占位 ─────────────────────────────────────
// 后端拒绝或查询失败都落到这里：只给「暂不可用」，不再区分具体原因，
// 也不弹 Toast 风暴（规格 08.1 5.6）。
const STATS_UNAVAILABLE_NOTICE = '部分统计暂不可用，下面只展示当前可用的数据。'
const TOKEN_STATS_UNAVAILABLE = 'Token 统计暂不可用'

/** 把一个请求的失败收敛成结果对象，避免 Promise.all 整块失败。 */
type Settled<T> = { ok: true; data: T } | { ok: false; error: string }

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    data => ({ ok: true as const, data }),
    (err: unknown) => ({ ok: false as const, error: (err as Error)?.message || String(err) }),
  )
}

// ── 数据块状态机 ───────────────────────────────────────────────────
// idle：还没发起过请求；loading：首次加载；refreshing：已有数据、正在更新；
// ready：有数据；empty：请求成功但没有数据；error：请求失败。
type SliceStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'empty' | 'error'

function deriveSliceStatus(args: {
  loading: boolean
  loaded: boolean
  hasData: boolean
  error: string | null
}): SliceStatus {
  if (args.loading) return args.hasData ? 'refreshing' : 'loading'
  if (!args.loaded) return 'idle'
  if (args.error) return 'error'
  return args.hasData ? 'ready' : 'empty'
}

/** 保留图表、降低透明度，并在右上角显示更新中的 loader。 */
function SliceSurface({
  status,
  className,
  children,
}: {
  status: SliceStatus
  className?: string
  children: ReactNode
}) {
  const refreshing = status === 'refreshing'
  return (
    <div className={`relative ${className ?? ''}`} aria-busy={refreshing || undefined}>
      {refreshing && (
        <Loader2
          size={16}
          aria-hidden="true"
          className="absolute right-3 top-3 z-10 animate-spin text-brand-400"
        />
      )}
      <div className={refreshing ? 'opacity-60 transition-opacity' : undefined}>{children}</div>
    </div>
  )
}


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
type DbHealth = { pageCount: number; freelistPages: number; walSize: number; ok: boolean }

/**
 * 缓存按数据来源分段，每段带自己的请求 key。
 *
 * 为什么不是一份扁平对象 + 单一 key：
 * - 快照数据依赖 timeRange + groupBy；
 * - 排行数据只依赖 timeRange；
 * - 趋势数据依赖 timeRange + groupBy + rootOnly。
 * 切换 groupBy 时排行数据仍然有效，不能因为趋势 key 变了就整份丢弃；
 * 反过来，任何一段 key 不匹配时都不能把旧段的数据混进新结果。
 */
interface FastCacheSlice {
  dbStats: DatabaseStats | null
  tokenStats: TokenStats | null
  tokenGroupData: TokenGroupDataPoint[]
  dbHealth: DbHealth | null
}

interface StatsCacheSlice {
  toolRanking: ToolRanking[]
  skillUsage: SkillUsage[]
  modelRanking: ModelRankingItem[]
  providerStats: ProviderStatsItem[]
  projectRanking: ProjectRankingItem[]
}

interface TrendsCacheSlice {
  sessionTrend: SessionTrendItem[]
  costTrend: CostTrendItem[]
  messageTrend: MessageTrendItem[]
}

interface DashboardCache {
  fastKey: string | null
  fast: FastCacheSlice | null
  statsKey: string | null
  stats: StatsCacheSlice | null
  trendsKey: string | null
  trends: TrendsCacheSlice | null
  timeRange: TimeRange | undefined
  timePreset: TimePreset
  groupBy: GroupBy
  rootOnly: boolean
}

let dashboardCache: DashboardCache | null = null

function rangeKey(tr: TimeRange | undefined): string {
  return tr ? `${tr.startDate}~${tr.endDate}` : 'all'
}

function fastCacheKey(tr: TimeRange | undefined, gb: GroupBy): string {
  return `${rangeKey(tr)}|${gb}`
}

function trendsCacheKey(tr: TimeRange | undefined, gb: GroupBy, rootOnly: boolean): string {
  return `${rangeKey(tr)}|${gb}|${rootOnly ? 'root' : 'all'}`
}

function emptyDashboardCache(): DashboardCache {
  return {
    fastKey: null,
    fast: null,
    statsKey: null,
    stats: null,
    trendsKey: null,
    trends: null,
    timeRange: undefined,
    timePreset: 30,
    groupBy: 'day',
    rootOnly: false,
  }
}

/**
 * 读取可用于挂载的缓存。
 *
 * 只有「fast 段 key 与缓存自身的视图参数一致」且 dbStats 存在时才认这份缓存：
 * 否则说明缓存来自旧范围 / 旧 groupBy，宁可重新请求也不能显示错口径的数字。
 */
function readCachedDashboard(): DashboardCache | null {
  const cached = dashboardCache
  if (!cached || !cached.fast?.dbStats) return null
  if (cached.fastKey !== fastCacheKey(cached.timeRange, cached.groupBy)) return null
  return cached
}

function formatHm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 丢弃模块级缓存。
 *
 * 调用方：设置页「重新打开数据库」成功之后。运行期 OpenCode 完成迁移后，
 * 连接池仍是旧形态（TEMP VIEW 按连接生效），重新打开才会重建连接池；
 * 此时仪表盘的模块级缓存里还是**旧形态的数字**，必须一起丢弃，
 * 否则用户会看到「已经重新打开」却仍是旧统计。
 *
 * 清空后下一次挂载仪表盘会重新拉取数据。
 */
export function invalidateDashboardCache() {
  dashboardCache = null
}

// ── Dashboard ──────────────────────────────────────────────────────
function Dashboard() {
  const navigate = useNavigate()
  const { state: schemaState, derived: schema, refreshing: schemaRefreshing, refresh: refreshSchema } = useSchemaStatus()
  const { dbPath: contextDbPath } = useOptionalDataSource()
  // unsupported：整块换成受限占位，且**不发起任何统计 IPC**
  const schemaBlocked = schema.key === 'unsupported'
  // schema 尚未解析完成时先不发统计请求，避免 unsupported 下先拉一遍再丢弃
  const schemaResolved = schemaState.kind !== 'loading'
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(null)
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null)
  const [toolRanking, setToolRanking] = useState<ToolRanking[]>([])
  const [skillUsage, setSkillUsage] = useState<SkillUsage[]>([])
  const [tokenGroupData, setTokenGroupData] = useState<TokenGroupDataPoint[]>([])
  const [modelRanking, setModelRanking] = useState<ModelRankingItem[]>([])
  const [providerStats, setProviderStats] = useState<ProviderStatsItem[]>([])
  const [projectRanking, setProjectRanking] = useState<ProjectRankingItem[]>([])
  const [sessionTrend, setSessionTrend] = useState<SessionTrendItem[]>([])
  const [costTrend, setCostTrend] = useState<CostTrendItem[]>([])
  const [messageTrend, setMessageTrend] = useState<MessageTrendItem[]>([])

  // 对比上期数据（cost / session / message 三条趋势图共用同一开关）
  const [prevSessionTrend, setPrevSessionTrend] = useState<SessionTrendItem[]>([])
  const [prevCostTrend, setPrevCostTrend] = useState<CostTrendItem[]>([])
  const [prevMessageTrend, setPrevMessageTrend] = useState<MessageTrendItem[]>([])
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('overview')
  // 访问过的 tab 不卸载：趋势图切走再切回时保持同一个图表实例
  const [visitedTabs, setVisitedTabs] = useState<Set<DashboardTab>>(() => new Set(['overview']))

  // Time range & grouping state
  const [timePreset, setTimePreset] = useState<TimePreset>(30)
  const [timeRange, setTimeRange] = useState<TimeRange | undefined>(() => computeTimeRange(30))
  const [groupBy, setGroupBy] = useState<GroupBy>('day')
  const [showSessionCompare, setShowSessionCompare] = useState(true)
  const [showCostCompare, setShowCostCompare] = useState(true)
  const [showMessageCompare, setShowMessageCompare] = useState(true)
  const [customStart, setCustomStart] = useState<string>('')
  const [customEnd, setCustomEnd] = useState<string>('')

  // 根会话趋势过滤（仅当 dashboardTab === 'trends' 时生效）
  const [rootOnly, setRootOnly] = useState(false)

  const [connected, setConnected] = useState(false)
  const [dbPath, setDbPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [fastLoading, setFastLoading] = useState(false)
  const [slowLoading, setSlowLoading] = useState(false)
  // 按 tab 懒加载：stats / trends 是否已针对当前 key 完成过请求。
  // 不再用数组长度猜：空结果也是「已加载」。
  const [statsLoaded, setStatsLoaded] = useState(false)
  const [trendsLoaded, setTrendsLoaded] = useState(false)
  const [fastLoaded, setFastLoaded] = useState(false)
  const [trendsLoading, setTrendsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  // 一键 VACUUM 失败提示（B-14）：不随 3 秒消失，附原因与后续动作，成功或手动关闭后清除
  const [vacuumNotice, setVacuumNotice] = useState<string | null>(null)
  const [dbHealth, setDbHealth] = useState<DbHealth | null>(null)
  // 各统计块的失败原因（独立收敛，不再让整页失败）
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [trendsError, setTrendsError] = useState<string | null>(null)

  // 请求生命周期：generation 保证旧响应不写 state / cache / loading。
  const fastGenRef = useRef(0)
  const slowGenRef = useRef(0)
  const trendsGenRef = useRef(0)
  // 单飞：同一个 key 在途时直接跳过；finally 只清掉属于自己的那一次。
  const slowFlightRef = useRef<{ key: string; gen: number } | null>(null)
  const trendsFlightRef = useRef<{ key: string; gen: number } | null>(null)
  // 最近一次成功更新的时间，用于「更新失败，仍显示上一次结果（HH:mm）」。
  const lastSuccessRef = useRef<Date | null>(null)
  // tokenGroupData 对应的 fast key：只有同范围/同 groupBy 才能用来派生成本趋势。
  const tokenGroupKeyRef = useRef<string | null>(null)
  // 供 deps=[] 的 loader 读取最新输入，避免闭包拿到旧值。
  const timePresetRef = useRef<TimePreset>(timePreset)
  const rootOnlyRef = useRef(rootOnly)
  useEffect(() => { timePresetRef.current = timePreset }, [timePreset])
  useEffect(() => { rootOnlyRef.current = rootOnly }, [rootOnly])

  /** 失败时保留旧数据，并给出明确的「上一次结果」时间。 */
  const failureMessage = useCallback((message: string) => {
    const last = lastSuccessRef.current
    if (!last) return message
    return `更新失败，仍显示上一次结果（${formatHm(last)}）`
  }, [])

  const anyStatsData =
    toolRanking.length > 0 ||
    skillUsage.length > 0 ||
    modelRanking.length > 0 ||
    providerStats.length > 0 ||
    projectRanking.length > 0
  const anyTrendsData = sessionTrend.length > 0 || costTrend.length > 0 || messageTrend.length > 0
  const anyFastData = !!dbStats || !!tokenStats || tokenGroupData.length > 0


  // ── 修复问题 2：切回 Dashboard 时若 dbHealth 缺失则主动恢复 ──────────
  // 原因：路由切换 + Vite HMR 可能让模块级 dashboardCache 重新初始化，
  //      导致组件重新挂载时 useState 拿到的是 null。
  //      通过此 effect 重新拉一次 health check 即可。
  useEffect(() => {
    if (connected && dbHealth === null && !fastLoading) {
      invokeSafe<{ ok: boolean; pageCount: number; freelistPages: number; walSize: number }>(IPC_CHANNELS.DATABASE_HEALTH)
        .then((health) => {
          if (health) {
            const next: DbHealth = {
              pageCount: health.pageCount,
              freelistPages: health.freelistPages,
              walSize: health.walSize ?? 0,
              ok: health.ok,
            }
            setDbHealth(next)
            if (dashboardCache?.fast) {
              dashboardCache = {
                ...dashboardCache,
                fast: { ...dashboardCache.fast, dbHealth: next },
              }
            }
          }
        })
        .catch(() => { /* 保持 null，UI 显示"不可用"提示 */ })
    }
  }, [connected, dbHealth, fastLoading])

  const hasLoadedRef = useRef(false)

  // ── Load fast data (overview + tokens + health) ─────────────────────
  // 每个请求独立 catch：tokens 在 v2 下失败时 overview 仍要渲染，
  // 不能让 Promise.all 整块失败把整页打成「加载失败」（规格 08.1 5.6）。
  // generation：旧请求返回时直接丢弃，不写 state / cache / loading。
  const loadFastData = useCallback(async (tr: TimeRange | undefined, gb: GroupBy): Promise<FastCacheSlice | null> => {
    const gen = ++fastGenRef.current
    const key = fastCacheKey(tr, gb)
    setFastLoading(true)
    const [statsR, tokensR, groupR, healthR] = await Promise.all([
      settle(invokeSafe<DatabaseStats>(IPC_CHANNELS.DASHBOARD_OVERVIEW, tr)),
      settle(invokeSafe<TokenStats>(IPC_CHANNELS.DASHBOARD_TOKENS, tr)),
      settle(invokeSafe<TokenGroupDataPoint[]>(IPC_CHANNELS.DASHBOARD_TOKENS, { ...(tr || {}), groupBy: gb })),
      settle(invokeSafe<{ ok: boolean; pageCount: number; freelistPages: number; walSize: number }>(IPC_CHANNELS.DATABASE_HEALTH)),
    ])

    if (gen !== fastGenRef.current) return null

    // 失败只保留旧数据，不把旧值清成 null / 空数组。
    if (statsR.ok) setDbStats(statsR.data)
    setError(statsR.ok ? null : failureMessage(statsR.error))
    if (tokensR.ok) setTokenStats(tokensR.data)
    setTokenError(tokensR.ok ? null : failureMessage(tokensR.error))
    if (groupR.ok) {
      setTokenGroupData(groupR.data ?? [])
      tokenGroupKeyRef.current = key
    }

    const previous = dashboardCache?.fastKey === key ? dashboardCache.fast : null
    let nextHealth: DbHealth | null = previous?.dbHealth ?? null
    if (healthR.ok && healthR.data) {
      const health = healthR.data
      nextHealth = {
        pageCount: health.pageCount,
        freelistPages: health.freelistPages,
        walSize: health.walSize ?? 0,
        ok: health.ok,
      }
      setDbHealth(nextHealth)
    }
    if (statsR.ok || tokensR.ok || groupR.ok) lastSuccessRef.current = new Date()

    const nextFast: FastCacheSlice = {
      dbStats: statsR.ok ? statsR.data : previous?.dbStats ?? null,
      tokenStats: tokensR.ok ? tokensR.data : previous?.tokenStats ?? null,
      tokenGroupData: groupR.ok ? (groupR.data ?? []) : previous?.tokenGroupData ?? [],
      dbHealth: nextHealth,
    }
    dashboardCache = {
      ...(dashboardCache ?? emptyDashboardCache()),
      fastKey: key,
      fast: nextFast,
      timeRange: tr,
      timePreset: timePresetRef.current,
      groupBy: gb,
      rootOnly: rootOnlyRef.current,
    }

    setFastLoaded(true)
    setFastLoading(false)
    return nextFast
  }, [failureMessage])

  // ── Load stats data (tools + skills + models + providers) ────────
  // 仅在切换到"统计"tab 时按需加载；同 range 的单飞请求直接跳过。
  const loadSlowData = useCallback(async (tr: TimeRange | undefined): Promise<StatsCacheSlice | null> => {
    const key = rangeKey(tr)
    if (slowFlightRef.current?.key === key) return null
    const gen = ++slowGenRef.current
    slowFlightRef.current = { key, gen }
    setSlowLoading(true)
    try {
      const [toolsR, skillsR, modelsR, providersR, projectsR] = await Promise.all([
        settle(invokeSafe<ToolRanking[]>(IPC_CHANNELS.DASHBOARD_TOOL_RANKING, tr)),
        settle(invokeSafe<SkillUsage[]>(IPC_CHANNELS.DASHBOARD_SKILL_USAGE, tr)),
        settle(invokeSafe<ModelRankingItem[]>(IPC_CHANNELS.DASHBOARD_MODEL_RANKING, tr)),
        settle(invokeSafe<ProviderStatsItem[]>(IPC_CHANNELS.DASHBOARD_PROVIDER_STATS, tr)),
        settle(invokeSafe<ProjectRankingItem[]>(IPC_CHANNELS.DASHBOARD_PROJECT_RANKING, tr)),
      ])
      if (gen !== slowGenRef.current) return null

      // 只写成功段；失败段保留上一次的结果。
      if (toolsR.ok) setToolRanking(toolsR.data ?? [])
      if (skillsR.ok) setSkillUsage(skillsR.data ?? [])
      if (modelsR.ok) setModelRanking(modelsR.data ?? [])
      if (providersR.ok) setProviderStats(providersR.data ?? [])
      if (projectsR.ok) setProjectRanking(projectsR.data ?? [])

      const firstError = [toolsR, skillsR, modelsR, providersR, projectsR].find(r => !r.ok)
      setStatsError(firstError && !firstError.ok ? failureMessage(firstError.error) : null)
      if ([toolsR, skillsR, modelsR, providersR, projectsR].some(r => r.ok)) {
        lastSuccessRef.current = new Date()
      }

      const previous = dashboardCache?.statsKey === key ? dashboardCache.stats : null
      const nextStats: StatsCacheSlice = {
        toolRanking: toolsR.ok ? (toolsR.data ?? []) : previous?.toolRanking ?? [],
        skillUsage: skillsR.ok ? (skillsR.data ?? []) : previous?.skillUsage ?? [],
        modelRanking: modelsR.ok ? (modelsR.data ?? []) : previous?.modelRanking ?? [],
        providerStats: providersR.ok ? (providersR.data ?? []) : previous?.providerStats ?? [],
        projectRanking: projectsR.ok ? (projectsR.data ?? []) : previous?.projectRanking ?? [],
      }
      dashboardCache = {
        ...(dashboardCache ?? emptyDashboardCache()),
        statsKey: key,
        stats: nextStats,
      }
      setStatsLoaded(true)
      return nextStats
    } finally {
      if (slowFlightRef.current?.key === key && slowFlightRef.current.gen === gen) {
        slowFlightRef.current = null
      }
      if (slowGenRef.current === gen) setSlowLoading(false)
    }
  }, [failureMessage])

  // ── Load trends data (session + cost + message trends) ───────────
  // 仅在切换到"趋势"tab 时按需加载；key 含 range / groupBy / rootOnly。
  const loadTrendsData = useCallback(async (
    tr: TimeRange | undefined,
    gb: GroupBy,
    onlyRoot: boolean,
    groupData: TokenGroupDataPoint[],
  ): Promise<TrendsCacheSlice | null> => {
    const key = trendsCacheKey(tr, gb, onlyRoot)
    if (trendsFlightRef.current?.key === key) return null
    const gen = ++trendsGenRef.current
    trendsFlightRef.current = { key, gen }
    setTrendsLoading(true)
    try {
      // 只有 tokenGroupData 与当前 range/groupBy 同源时才用于派生成本趋势，
      // 否则切范围的瞬间会拿上一范围的 groupData 画出错误的成本曲线。
      const groupSource = tokenGroupKeyRef.current === fastCacheKey(tr, gb) ? groupData : []
      const [sessionR, costR, msgR] = await Promise.all([
        settle(invokeSafe<SessionTrendItem[]>(IPC_CHANNELS.DASHBOARD_SESSION_TREND, tr, onlyRoot)),
        gb === 'day' && groupSource.length > 0
          ? Promise.resolve<Settled<CostTrendItem[]>>({ ok: true, data: groupSource.map(({ period, estimatedCost }) => ({ date: period, value: estimatedCost, totalCost: estimatedCost })) })
          : settle(invokeSafe<CostTrendItem[]>(IPC_CHANNELS.DASHBOARD_COST_TREND, tr)),
        settle(invokeSafe<MessageTrendItem[]>(IPC_CHANNELS.DASHBOARD_MESSAGE_TREND, tr)),
      ])
      if (gen !== trendsGenRef.current) return null

      // 只写成功段；失败段保留上一次的结果。
      if (sessionR.ok) setSessionTrend(sessionR.data ?? [])
      if (costR.ok) setCostTrend(costR.data ?? [])
      if (msgR.ok) setMessageTrend(msgR.data ?? [])

      const firstError = [sessionR, costR, msgR].find(r => !r.ok)
      setTrendsError(firstError && !firstError.ok ? failureMessage(firstError.error) : null)
      if ([sessionR, costR, msgR].some(r => r.ok)) lastSuccessRef.current = new Date()

      const previous = dashboardCache?.trendsKey === key ? dashboardCache.trends : null
      const nextTrends: TrendsCacheSlice = {
        sessionTrend: sessionR.ok ? (sessionR.data ?? []) : previous?.sessionTrend ?? [],
        costTrend: costR.ok ? (costR.data ?? []) : previous?.costTrend ?? [],
        messageTrend: msgR.ok ? (msgR.data ?? []) : previous?.messageTrend ?? [],
      }
      dashboardCache = {
        ...(dashboardCache ?? emptyDashboardCache()),
        trendsKey: key,
        trends: nextTrends,
      }
      setTrendsLoaded(true)
      return nextTrends
    } finally {
      if (trendsFlightRef.current?.key === key && trendsFlightRef.current.gen === gen) {
        trendsFlightRef.current = null
      }
      if (trendsGenRef.current === gen) setTrendsLoading(false)
    }
  }, [failureMessage])

  // ── Load overview data only (懒加载策略) ─────────────────────────
  // 首次加载 / 切换数据库 / VACUUM/Checkpoint 后只加载 overview tab 所需数据
  // stats / trends 数据在切换到对应 tab 时按需加载
  const loadAllData = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) {
      // 让在途的 stats / trends 请求失效，避免旧响应把 loaded 又置回 true
      slowGenRef.current += 1
      trendsGenRef.current += 1
      slowFlightRef.current = null
      trendsFlightRef.current = null
      setSlowLoading(false)
      setTrendsLoading(false)
      setStatsLoaded(false)
      setTrendsLoaded(false)
      setStatsError(null)
      setTrendsError(null)
    }
    setError(null)
    await loadFastData(timeRange, groupBy)
  }, [loadFastData, timeRange, groupBy])

  // ── Refresh handler (只刷新当前 tab 数据) ────────────────────────
  // stats / trends 由 tab 懒加载 effect 作为唯一入口；这里只重置 loaded。
  const handleRefresh = useCallback(async () => {
    if (schemaBlocked) return
    setRefreshing(true)
    setError(null)
    try {
      await invokeSafe<void>(IPC_CHANNELS.DASHBOARD_REFRESH_ATTRIBUTION)
      slowGenRef.current += 1
      trendsGenRef.current += 1
      slowFlightRef.current = null
      trendsFlightRef.current = null
      setSlowLoading(false)
      setTrendsLoading(false)
      setStatsLoaded(false)
      setTrendsLoaded(false)
      setStatsError(null)
      setTrendsError(null)
      await loadFastData(timeRange, groupBy)
    } catch (err) {
      setError((err as Error).message || 'Failed to refresh dashboard data')
    } finally {
      setRefreshing(false)
    }
  }, [loadFastData, timeRange, groupBy, schemaBlocked])

  // ── Initial connection check ─────────────────────────────────────
  useEffect(() => {
    if (hasLoadedRef.current) return
    // schema 尚未解析完成时先不发统计请求（unsupported 下不得发起任何统计 IPC）
    if (!schemaResolved) return
    if (schemaBlocked) {
      setLoading(false)
      hasLoadedRef.current = true
      return
    }
    async function init() {
      // 缓存挂载：必须有 key + dbStats，且各段 key 与缓存的视图参数一致
      const cached = readCachedDashboard()
      if (cached) {
        const fast = cached.fast
        const statsKeyMatches = cached.statsKey === rangeKey(cached.timeRange)
        const trendsKeyMatches = cached.trendsKey === trendsCacheKey(cached.timeRange, cached.groupBy, cached.rootOnly)
        setDbStats(fast?.dbStats ?? null)
        setTokenStats(fast?.tokenStats ?? null)
        setTokenGroupData(fast?.tokenGroupData ?? [])
        setDbHealth(fast?.dbHealth ?? null)
        setToolRanking(statsKeyMatches ? cached.stats?.toolRanking ?? [] : [])
        setSkillUsage(statsKeyMatches ? cached.stats?.skillUsage ?? [] : [])
        setModelRanking(statsKeyMatches ? cached.stats?.modelRanking ?? [] : [])
        setProviderStats(statsKeyMatches ? cached.stats?.providerStats ?? [] : [])
        setProjectRanking(statsKeyMatches ? cached.stats?.projectRanking ?? [] : [])
        setSessionTrend(trendsKeyMatches ? cached.trends?.sessionTrend ?? [] : [])
        setCostTrend(trendsKeyMatches ? cached.trends?.costTrend ?? [] : [])
        setMessageTrend(trendsKeyMatches ? cached.trends?.messageTrend ?? [] : [])
        setTimeRange(cached.timeRange)
        setTimePreset(cached.timePreset)
        setGroupBy(cached.groupBy)
        setRootOnly(cached.rootOnly)
        setStatsLoaded(statsKeyMatches)
        setTrendsLoaded(trendsKeyMatches)
        setFastLoaded(true)
        setConnected(true)
        setLoading(false)
        setFastLoading(false)
        setSlowLoading(false)
        setTrendsLoading(false)
        lastSuccessRef.current = new Date()
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
  }, [loadAllData, schemaResolved, schemaBlocked])

  // ── Tab 切换懒加载 ───────────────────────────────────────────────
  // stats / trends 的唯一触发源：handler 只改输入 + 重置 loaded。
  useEffect(() => {
    if (!connected) return
    if (schemaBlocked) return
    if (dashboardTab === 'stats' && !statsLoaded) {
      void loadSlowData(timeRange)
    } else if (dashboardTab === 'trends' && !trendsLoaded) {
      void loadTrendsData(timeRange, groupBy, rootOnly, tokenGroupData)
    }
  }, [
    dashboardTab,
    statsLoaded,
    trendsLoaded,
    connected,
    timeRange,
    groupBy,
    rootOnly,
    tokenGroupData,
    loadSlowData,
    loadTrendsData,
    schemaBlocked,
  ])

  // ── Connect to a database ────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    try {
      const filePath = await invokeSafe<string>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      const result = await invokeSafe<{ path: string }>(IPC_CHANNELS.DATABASE_OPEN, filePath)
      setConnected(true)
      setDbPath(result.path ?? filePath)
      invalidateDashboardCache()
      await loadAllData(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [loadAllData])

  // ── 打开数据库所在目录（unsupported 占位里的取证入口）────────────
  const handleRevealDirectory = useCallback(async () => {
    try {
      await invokeSafe<boolean>(IPC_CHANNELS.SHELL_REVEAL_DATABASE_DIRECTORY)
    } catch {
      /* 打开目录失败不打断页面 */
    }
  }, [])

  // ── 切换数据源（unsupported 时唯一的出路）─────────────────────────
  const handleSwitchDataSource = useCallback(async () => {
    try {
      const filePath = await invokeSafe<string | null>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      if (!filePath) return
      await invokeSafe<string>(IPC_CHANNELS.DATABASE_OPEN, filePath)
      window.location.reload()
    } catch {
      /* 切换失败保持当前占位 */
    }
  }, [])

  // ── Vacuum ───────────────────────────────────────────────────────
  const handleVacuum = useCallback(async () => {
    setActionLoading('vacuum')
    try {
      const result = await invokeSafe<{ before: number; after: number; freed: number }>(IPC_CHANNELS.DATABASE_VACUUM)
      setToast({ message: `VACUUM 完成! 释放空间: ${formatBytes(result.freed)}`, type: 'success' })
      setTimeout(() => setToast(null), 3000)
      setVacuumNotice(null)
      await loadAllData(true)
    } catch (err) {
      // 失败提示不再用 3 秒 toast：磁盘回收失败需要用户看到原因与后续动作
      setVacuumNotice((err as Error).message || '未知错误')
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

  // ── Time range change handler (只改输入，触发由 tab lazy effect 负责) ──
  const handleTimePresetChange = useCallback((days: TimePreset) => {
    setTimePreset(days)
    const tr = computeTimeRange(days, customStart, customEnd)
    setTimeRange(tr)
    // 旧范围的在途请求立即失效；stats / trends 由 tab effect 重新触发
    slowGenRef.current += 1
    trendsGenRef.current += 1
    slowFlightRef.current = null
    trendsFlightRef.current = null
    setSlowLoading(false)
    setTrendsLoading(false)
    setStatsLoaded(false)
    setTrendsLoaded(false)
    setStatsError(null)
    setTrendsError(null)
    setError(null)
    invalidateDashboardCache()
    void loadFastData(tr, groupBy)
  }, [customStart, customEnd, groupBy, loadFastData])

  // ── GroupBy change handler（只影响 tokenGroupData / 趋势 key）──────
  const handleGroupByChange = useCallback((gb: GroupBy) => {
    setGroupBy(gb)
    // stats 不依赖 groupBy，保留已加载状态；trends key 变化必须重算
    trendsGenRef.current += 1
    trendsFlightRef.current = null
    setTrendsLoading(false)
    setTrendsLoaded(false)
    setTrendsError(null)
    void loadFastData(timeRange, gb)
  }, [loadFastData, timeRange])

  // ── 根会话过滤（趋势 key 变化）───────────────────────────────────
  const handleRootOnlyChange = useCallback(() => {
    const next = !rootOnly
    rootOnlyRef.current = next
    setRootOnly(next)
    trendsGenRef.current += 1
    trendsFlightRef.current = null
    setTrendsLoading(false)
    setTrendsLoaded(false)
    setTrendsError(null)
  }, [rootOnly])

  const handleDashboardTabChange = useCallback((tab: DashboardTab) => {
    setDashboardTab(tab)
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev
      const next = new Set(prev)
      next.add(tab)
      return next
    })
  }, [])

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
    const sessionPromise = showSessionCompare
      ? invokeSafe<SessionTrendItem[]>(IPC_CHANNELS.DASHBOARD_SESSION_TREND, prevTR, rootOnly).catch(() => [] as SessionTrendItem[])
      : Promise.resolve([] as SessionTrendItem[])
    const costPromise = showCostCompare
      ? invokeSafe<CostTrendItem[]>(IPC_CHANNELS.DASHBOARD_COST_TREND, prevTR).catch(() => [] as CostTrendItem[])
      : Promise.resolve([] as CostTrendItem[])
    const messagePromise = showMessageCompare
      ? invokeSafe<MessageTrendItem[]>(IPC_CHANNELS.DASHBOARD_MESSAGE_TREND, prevTR).catch(() => [] as MessageTrendItem[])
      : Promise.resolve([] as MessageTrendItem[])
    Promise.all([sessionPromise, costPromise, messagePromise]).then(([s, c, m]) => {
      if (cancelled) return
      setPrevSessionTrend(s ?? [])
      setPrevCostTrend(c ?? [])
      setPrevMessageTrend(m ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [anyNewCompareOn, dashboardTab, timeRange, rootOnly, showSessionCompare, showCostCompare, showMessageCompare])

  // ── Unsupported view（整块受限占位）─────────────────────────────
  // 优先级最高：unsupported 时不显示「未连接数据库」空态，也不发起统计 IPC。
  if (schemaBlocked) {
    // 占位里展示的是「打不开的那个文件」；「打开所在目录」只对已打开的库有效
    const blockedPath = schema.path || dbPath || contextDbPath
    const revealPath = contextDbPath || dbPath
    return (
      <div className="p-4 space-y-4 max-w-[1400px] mx-auto">
        <PageHeader
          icon={<LayoutDashboard size={24} />}
          title="仪表盘"
          description={blockedPath || undefined}
        />
        <SchemaBlockedState
          reason={schema.reason}
          path={blockedPath}
          refreshing={schemaRefreshing}
          onRetry={() => { void refreshSchema() }}
          // 拿不到路径就不渲染，不用 shell:reveal 失败来兜底
          onReveal={revealPath ? handleRevealDirectory : undefined}
          onSwitch={handleSwitchDataSource}
        />
      </div>
    )
  }

  // ── Not connected view ───────────────────────────────────────────
  if (!connected && !loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <Unplug size={48} className="mx-auto text-gray-300 mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">未连接数据库</h2>
          <p className="text-gray-500 mb-6">
            请选择一个 OpenCode SQLite 数据库开始使用。
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
            连接数据库
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
          <h2 className="text-xl font-semibold text-gray-900 mb-2">数据加载失败</h2>
          <p className="text-gray-500 mb-4 text-sm">{error}</p>
          <button
            onClick={() => loadAllData(true)}
            className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm"
          >
            重试
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

  // ── 降级态派生 ───────────────────────────────────────────────────
  const isV2Schema = schema.mode === 'v2' || schema.mode === 'v2-mixed'
  // Token 统计占位：失败时给统一文案，不显示「暂无Token数据」误导用户
  const tokenPlaceholder = tokenError ? TOKEN_STATS_UNAVAILABLE : '暂无Token数据'

  // ── 数据块状态机 ─────────────────────────────────────────────────
  const fastStatus = deriveSliceStatus({
    loading: fastLoading,
    loaded: fastLoaded,
    hasData: anyFastData,
    error,
  })
  const statsStatus = deriveSliceStatus({
    loading: slowLoading,
    loaded: statsLoaded,
    hasData: anyStatsData,
    error: statsError,
  })
  const trendsStatus = deriveSliceStatus({
    loading: trendsLoading,
    loaded: trendsLoaded,
    hasData: anyTrendsData,
    error: trendsError,
  })
  const isUpdating = fastLoading || slowLoading || trendsLoading
  const hasAnyData = anyFastData || anyStatsData || anyTrendsData
  const staleError = error ?? statsError ?? trendsError
  // 范围按钮下方唯一的 live region：加载中或失败保留旧数据时给出可见反馈。
  const statusText = isUpdating
    ? hasAnyData
      ? '正在更新数据，当前显示上一次结果…'
      : '正在加载数据…'
    : staleError && hasAnyData
      ? staleError
      : ''

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
            onClick={() => handleDashboardTabChange(tab.key)}
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
        <div
          role="status"
          aria-live="polite"
          className="mt-2 min-h-[1rem] text-xs text-gray-500"
        >
          {statusText}
        </div>
      </div>

      {/* ── Tab 内容（访问过的 tab 保活，切回不重挂载） ───────────── */}
      {visitedTabs.has('overview') && (
        <div hidden={dashboardTab !== 'overview'} className="space-y-6">
          {/* ── 上部：左右结构 ── */}
          <div className="grid grid-cols-2 gap-6 items-stretch">
            {/* 左：时段统计 2×2 卡片 */}
            <div className="flex flex-col">
              <p className="text-xs text-gray-400 font-medium mb-2">📈 时段统计
              </p>
              {!dbStats && (fastStatus === 'loading' || fastStatus === 'idle') ? (
                <div className="grid grid-cols-2 gap-4 flex-1">
                  {[1,2,3,4].map(i => (
                    <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse">
                      <div className="h-3 bg-gray-200 rounded w-16 mb-3" />
                      <div className="h-6 bg-gray-200 rounded w-24" />
                    </div>
                  ))}
                </div>
              ) : dbStats ? (
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
                    label={isV2Schema ? '消息行数' : 'Part行数'}
                    value={formatNumber(dbStats.partCount)}
                    icon={<Layers size={20} />}
                  />
                  <StatCard
                    label="估算成本"
                    value={tokenStats ? `$${(tokenStats.estimatedCost ?? 0).toFixed(2)}` : '-'}
                    icon={<DollarSign size={20} />}
                  />
                </div>
              ) : null}
            </div>

            {/* 右：Token 饼图统计（从趋势 Tab 移过来） */}
            <div className="flex flex-col">
              <p className="text-xs text-gray-400 font-medium mb-2">💰 Token 统计</p>
              <div className="bg-white rounded-lg border border-gray-200 p-5 flex-1">
                <SliceSurface status={fastStatus} className="h-full">
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
                            isAnimationActive={false}
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
                      <div className="flex items-center justify-between border-b border-gray-100 pb-2 mb-1">
                        <span className="text-xs font-semibold text-gray-700">Token 总计</span>
                        <span className="text-sm font-semibold text-gray-900">{formatNumber(sumTokenTotal(tokenStats))}</span>
                      </div>
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
                      <TokenMetricRow
                        label="缓存读Token"
                        value={formatNumber(tokenStats.cacheRead)}
                        color="bg-amber-500"
                      />
                      <TokenMetricRow
                        label="缓存写Token"
                        value={formatNumber(tokenStats.cacheWrite)}
                        color="bg-rose-500"
                      />
                      <div className="border-t border-gray-100 pt-2 mt-2">
                        <TokenMetricRow
                           label="缓存命中率"
                           value={`${(tokenStats.cacheHitRate ?? 0).toFixed(1)}%`}
                          color="bg-amber-500"
                        />
                      </div>
                    </div>
                  </div>
                ) : fastStatus === 'loading' || fastStatus === 'idle' ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 size={20} className="animate-spin text-brand-400" />
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">{tokenPlaceholder}</p>
                )}
                </SliceSurface>
              </div>
            </div>
          </div>

          {/* ── 下部：数据库概览（与时间范围无关） ── */}
          <div>
            <p className="text-xs text-gray-400 font-medium mb-2">🗄 数据库概览
            </p>
            {!dbStats && (fastStatus === 'loading' || fastStatus === 'idle') ? (
              <div className="grid grid-cols-4 gap-4">
                {[1,2,3,4].map(i => (
                  <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 h-24 animate-pulse">
                    <div className="h-3 bg-gray-200 rounded w-16 mb-3" />
                    <div className="h-6 bg-gray-200 rounded w-24" />
                  </div>
                ))}
              </div>
            ) : dbStats ? (
              <SliceSurface status={fastStatus}>
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
                {/* 一键 VACUUM 失败提示（B-14）：常驻直到成功或手动关闭，
                    主文案给结论与动作，原始错误以小字保留，不藏到无处 */}
                {vacuumNotice && (
                  <div role="alert" className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="font-medium leading-5">
                          磁盘回收未完成，数据本身不受影响。建议先退出 OpenCode 后重试；或先备份再通过清理向导处理。
                        </p>
                        <p className="text-amber-700 break-words select-text">失败原因：{vacuumNotice}</p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5">
                          <Link to="/backup" className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
                            打开备份页
                          </Link>
                          <Link to="/cleanup" className="text-brand-700 underline underline-offset-2 hover:text-brand-800">
                            打开清理向导
                          </Link>
                          <button
                            type="button"
                            onClick={() => setVacuumNotice(null)}
                            className="ml-auto text-amber-700 hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
                          >
                            知道了
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {!dbHealth && (
                  <p className="text-sm text-gray-400 text-center py-4 bg-white rounded-lg border border-gray-200">数据库状态不可用</p>
                )}
              </div>
              </SliceSurface>
            ) : (
              <p className="text-sm text-gray-400 text-center py-8">数据库状态不可用</p>
            )}
          </div>
        </div>
      )}

      {visitedTabs.has('trends') && (
        <div
          hidden={dashboardTab !== 'trends'}
          data-testid="trends-panel"
          className="grid grid-cols-2 gap-6 items-stretch"
        >
          {trendsError && (
            <p role="status" className="col-span-2 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
              {trendsError.includes('更新失败') ? trendsError : STATS_UNAVAILABLE_NOTICE}
            </p>
          )}
          {/* Token 折线图（饼图已移到概览） */}
          <div className="h-full flex flex-col">
            <p className="text-xs text-gray-400 font-medium mb-2">📊 Token 趋势
            </p>
            <div className="bg-white rounded-lg border border-gray-200 p-5 relative flex-1 flex flex-col">
              <SliceSurface status={fastStatus} className="flex-1 flex flex-col">
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
                         content={({ active, payload }) => {
                           if (!active || !payload || !payload.length) return null
                           const data = payload[0].payload as TokenGroupDataPoint
                           const totalAttempts = data.cacheRead + data.inputTokens
                           const hitRate = totalAttempts > 0
                             ? (data.cacheRead / totalAttempts * 100).toFixed(1)
                             : '—'
                           return (
                             <div style={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#fff', padding: '8px 12px' }}>
                               {payload.map((entry, i) => (
                                 <div key={i} style={{ color: entry.color, marginBottom: 2 }}>
                                   {entry.name}: {formatNumber(entry.value as number)}
                                 </div>
                               ))}
                               <div style={{ color: '#111827', fontWeight: 600, marginTop: 4, paddingTop: 4, borderTop: '1px solid #f0f0f0' }}>
                                 Token 总计: {formatNumber(sumTokenTotal(data))}
                               </div>
                               <div style={{ color: '#6b7280', marginTop: 4, paddingTop: 4, borderTop: '1px solid #f0f0f0' }}>
                                 缓存命中率: {hitRate}%
                               </div>
                             </div>
                           )
                         }}
                       />
                      <Line isAnimationActive={false} type="monotone" dataKey="inputTokens" name="输入" stroke="#3B82F6" strokeWidth={2} dot={false} />
                      <Line isAnimationActive={false} type="monotone" dataKey="outputTokens" name="输出" stroke="#10B981" strokeWidth={2} dot={false} />
                      <Line isAnimationActive={false} type="monotone" dataKey="reasoningTokens" name="推理" stroke="#8B5CF6" strokeWidth={2} dot={false} />
                      <Line isAnimationActive={false} type="monotone" dataKey="cacheRead" name="缓存读" stroke="#F59E0B" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : fastStatus === 'loading' || fastStatus === 'idle' ? (
                <div className="h-40 flex items-center justify-center">
                  <Loader2 size={20} className="text-brand-400 animate-spin" />
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无Token趋势数据</p>
              )}
              </SliceSurface>
            </div>
          </div>

          {/* 成本趋势 (右上) */}
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium">💰 成本趋势
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
              <SliceSurface status={trendsStatus} className="flex-1">
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
                      <Line isAnimationActive={false} type="monotone" dataKey="totalCost" name="成本" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                      {showCostCompare && prevCostTrend.length > 0 && (
                        <Line
                          isAnimationActive={false}
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
              ) : trendsStatus === 'loading' || trendsStatus === 'idle' ? (
                <div className="h-40 flex items-center justify-center">
                  <Loader2 size={20} className="text-brand-400 animate-spin" />
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无数据</p>
              )}
              </SliceSurface>
            </div>
          </div>

          {/* 会话创建趋势 (左下) */}
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium">
                📅 会话创建趋势
                <button
                  onClick={handleRootOnlyChange}
                  className={`ml-2 px-2 py-0.5 text-xs rounded-full border transition-colors ${
                    rootOnly
                      ? 'bg-brand-100 text-brand-700 border-brand-300'
                      : 'text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                  title="切换根会话过滤（仅统计 parent_id IS NULL 的会话）"
                >
                  {rootOnly ? '仅根会话' : '全部会话'}
                </button>
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
              <SliceSurface status={trendsStatus} className="flex-1">
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
                      <Line isAnimationActive={false} type="monotone" dataKey="count" name="会话数" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                      {showSessionCompare && prevSessionTrend.length > 0 && (
                        <Line isAnimationActive={false} type="monotone" dataKey="prevCount" name="上期会话数" stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="5 5" dot={false} activeDot={{ r: 2 }} />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : trendsStatus === 'loading' || trendsStatus === 'idle' ? (
                <div className="h-40 flex items-center justify-center">
                  <Loader2 size={20} className="text-brand-400 animate-spin" />
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无数据</p>
              )}
              </SliceSurface>
            </div>
          </div>

          {/* 消息活跃度趋势 (右下) */}
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium">💬 消息活跃度趋势
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
              <SliceSurface status={trendsStatus} className="flex-1">
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
                      <Line isAnimationActive={false} type="monotone" dataKey="count" name="消息数" stroke="#8b5cf6" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
                      {showMessageCompare && prevMessageTrend.length > 0 && (
                        <Line
                          isAnimationActive={false}
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
              ) : trendsStatus === 'loading' || trendsStatus === 'idle' ? (
                <div className="h-40 flex items-center justify-center">
                  <Loader2 size={20} className="text-brand-400 animate-spin" />
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无数据</p>
              )}
              </SliceSurface>
            </div>
          </div>
        </div>
      )}

      {visitedTabs.has('stats') && (
        <div hidden={dashboardTab !== 'stats'} className="space-y-6">
          {statsError && (
            <p role="status" className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
              {statsError.includes('更新失败') ? statsError : STATS_UNAVAILABLE_NOTICE}
            </p>
          )}
          {/* 上层：工具&技能 */}
          <div>
            <p className="text-xs text-gray-400 font-medium mb-2">🔧 工具 & 技能排行
            </p>
            <div className="grid grid-cols-2 gap-4">
              {/* Skill Usage */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h3 className="text-sm font-medium text-gray-700 mb-4">技能使用分布</h3>
                <SliceSurface status={statsStatus}>
                {skillData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={skillData} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
                      <XAxis type="number" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={110}
                        interval={0}
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
                      <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
                        {skillData.map((_entry, index) => (
                          <Cell key={`skill-${index}`} fill={SKILL_COLORS[index % SKILL_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : statsStatus === 'loading' || statsStatus === 'idle' ? (
                  <div className="h-[220px] flex items-center justify-center">
                    <Loader2 size={20} className="text-brand-400 animate-spin" />
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">暂无技能使用数据</p>
                )}
                </SliceSurface>
              </div>

              {/* Tool Ranking */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h3 className="text-sm font-medium text-gray-700 mb-4">工具使用排行 TOP 10</h3>
                <SliceSurface status={statsStatus}>
                {toolData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={toolData} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
                      <XAxis type="number" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={140}
                        interval={0}
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
                      <Bar dataKey="count" fill={TOOL_BAR_COLOR} radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : statsStatus === 'loading' || statsStatus === 'idle' ? (
                  <div className="h-[220px] flex items-center justify-center">
                    <Loader2 size={20} className="text-brand-400 animate-spin" />
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">暂无工具使用数据</p>
                )}
                </SliceSurface>
              </div>
            </div>
          </div>

          {/* 下层：模型&Provider统计 */}
          <div>
            <p className="text-xs text-gray-400 font-medium mb-2">🤖 模型 & Provider 统计</p>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <SliceSurface status={statsStatus}>
              {modelRanking.length > 0 ? (
                <>
                  {(() => {
                    const modelChartData = modelRanking
                      .slice()
                      .sort((a, b) => b.tokenCount - a.tokenCount)
                      .slice(0, 10)
                      .map(m => {
                        let label = m.model
                        if (m.model?.startsWith('{')) {
                          try {
                            const p = JSON.parse(m.model)
                            const id = p.id || p.name || m.model
                            const pid = p.providerID || ''
                            label = pid ? `${pid} / ${id}` : id
                          } catch { /* keep raw */ }
                        }
                        return { name: label, tokens: m.tokenCount }
                      })
                    return (
                      <ResponsiveContainer width="100%" height={modelChartData.length * 36 + 20}>
                        <BarChart data={modelChartData} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
                          <XAxis type="number" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                          <YAxis
                            type="category"
                            dataKey="name"
                            width={180}
                            interval={0}
                            tick={{ fontSize: 11 }}
                            stroke="#9ca3af"
                          />
                          <Tooltip
                            contentStyle={{
                              fontSize: '12px',
                              borderRadius: '8px',
                              border: '1px solid #e5e7eb',
                            }}
                            content={({ active, payload }) => {
                              if (!active || !payload || !payload.length) return null
                              const data = payload[0].payload as { name: string; tokens: number }
                              return (
                                <div style={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#fff', padding: '8px 12px' }}>
                                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{data.name}</div>
                                  <div>Token 总计: {formatLargeNumber(data.tokens ?? 0)}</div>
                                </div>
                              )
                            }}
                          />
                          <Bar dataKey="tokens" fill={TOOL_BAR_COLOR} radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    )
                  })()}
                  {providerStats.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {providerStats.map(p => (
                        <span key={p.provider} className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                          {p.provider}: {formatLargeNumber(p.tokenCount)} tokens · ${p.totalCost.toFixed(2)}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : statsStatus === 'loading' || statsStatus === 'idle' ? (
                <div className="h-24 flex items-center justify-center">
                  <Loader2 size={20} className="text-brand-400 animate-spin" />
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无模型数据</p>
              )}
              </SliceSurface>
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-400 font-medium mb-2">📁 项目 Token 排行 TOP 10</p>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <SliceSurface status={statsStatus}>
              {projectRanking.length > 0 ? (
                <ResponsiveContainer width="100%" height={projectRanking.length * 36 + 20}>
                  <BarChart data={projectRanking.map(p => ({ name: p.project, tokens: p.tokenCount, cost: p.totalCost }))} layout="vertical" margin={{ left: 0, right: 20, top: 0, bottom: 0 }}>
                    <XAxis type="number" tick={{ fontSize: 11 }} stroke="#9ca3af" />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={140}
                      interval={0}
                      tick={{ fontSize: 11 }}
                      stroke="#9ca3af"
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: '12px',
                        borderRadius: '8px',
                        border: '1px solid #e5e7eb',
                      }}
                      content={({ active, payload }) => {
                        if (!active || !payload || !payload.length) return null
                        const data = payload[0].payload as { name: string; tokens: number; cost: number }
                        return (
                          <div style={{ fontSize: '12px', borderRadius: '8px', border: '1px solid #e5e7eb', background: '#fff', padding: '8px 12px' }}>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>{data.name}</div>
                            <div>Token 总计: {formatLargeNumber(data.tokens ?? 0)}</div>
                            <div>费用: ${(data.cost ?? 0).toFixed(2)}</div>
                          </div>
                        )
                      }}
                    />
                    <Bar dataKey="tokens" fill="#10b981" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              ) : statsStatus === 'loading' || statsStatus === 'idle' ? (
                <div className="h-24 flex items-center justify-center">
                  <Loader2 size={20} className="text-brand-400 animate-spin" />
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">暂无项目 Token 数据</p>
              )}
              </SliceSurface>
            </div>
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
