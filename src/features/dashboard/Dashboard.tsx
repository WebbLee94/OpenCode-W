import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router'
import type {
  DatabaseStats,
  TokenStats,
  ToolRanking,
  SkillUsage,
  TrendComparison,
  TimeRange,
  TokenGroupDataPoint,
} from '@shared/types'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { invokeSafe } from '@/lib/ipc'
import {
  Database,
  MessageSquare,
  Folder,
  Trash2,
  FileText,
  Layers,
  DollarSign,
  RefreshCw,
  Sparkles,
  FileCheck,
  Loader2,
  AlertCircle,
  Unplug,
  Heart,
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
  Legend,
} from 'recharts'
import StatCard from '@/components/StatCard'
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
type TimePreset = 'all' | 7 | 30 | 90
type GroupBy = 'day' | 'week' | 'month'

function computeTimeRange(days: TimePreset): TimeRange | undefined {
  if (days === 'all') return undefined
  const endDate = new Date()
  const startDate = new Date()
  startDate.setDate(endDate.getDate() - days)
  return {
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  }
}

// ── Module-level cache ─────────────────────────────────────────────
interface DashboardCache {
  dbStats: DatabaseStats | null
  tokenStats: TokenStats | null
  tokenGroupData: TokenGroupDataPoint[]
  toolRanking: ToolRanking[]
  skillUsage: SkillUsage[]
  trendComparison: TrendComparison | null
  timeRange: TimeRange | undefined
  timePreset: TimePreset
  groupBy: GroupBy
}

let dashboardCache: DashboardCache | null = null

// ── Dashboard ──────────────────────────────────────────────────────
function Dashboard() {
  const navigate = useNavigate()
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(dashboardCache?.dbStats ?? null)
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(dashboardCache?.tokenStats ?? null)
  const [toolRanking, setToolRanking] = useState<ToolRanking[]>(dashboardCache?.toolRanking ?? [])
  const [skillUsage, setSkillUsage] = useState<SkillUsage[]>(dashboardCache?.skillUsage ?? [])
  const [trendComparison, setTrendComparison] = useState<TrendComparison | null>(dashboardCache?.trendComparison ?? null)
  const [tokenGroupData, setTokenGroupData] = useState<TokenGroupDataPoint[]>(dashboardCache?.tokenGroupData ?? [])

  // Time range & grouping state
  const [timePreset, setTimePreset] = useState<TimePreset>(30)
  const [timeRange, setTimeRange] = useState<TimeRange | undefined>(dashboardCache?.timeRange ?? computeTimeRange(30))
  const [groupBy, setGroupBy] = useState<GroupBy>(dashboardCache?.groupBy ?? 'day')
  const [showComparison, setShowComparison] = useState(true)

  const [connected, setConnected] = useState(!!dashboardCache)
  const [dbPath, setDbPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(!dashboardCache)
  const [fastLoading, setFastLoading] = useState(!dashboardCache?.dbStats)
  const [slowLoading, setSlowLoading] = useState(!dashboardCache?.toolRanking?.length && !dashboardCache?.skillUsage?.length && !dashboardCache?.trendComparison?.current?.length)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [dbHealth, setDbHealth] = useState<{ pageCount: number; freelistPages: number } | null>(null)

  const hasLoadedRef = useRef(!!dashboardCache)

  // ── Load fast data (overview + tokens + health) ─────────────────────
  const loadFastData = useCallback(async (tr: TimeRange | undefined, gb: GroupBy) => {
    setFastLoading(true)
    const [stats, tokens, groupData, health] = await Promise.all([
      invokeSafe<DatabaseStats>(IPC_CHANNELS.DASHBOARD_OVERVIEW, tr),
      invokeSafe<TokenStats>(IPC_CHANNELS.DASHBOARD_TOKENS, tr),         // no groupBy → TokenStats
      invokeSafe<TokenGroupDataPoint[]>(IPC_CHANNELS.DASHBOARD_TOKENS, tr, gb),  // with groupBy → grouped data
      invokeSafe<{ ok: boolean; pageCount: number; freelistPages: number }>(IPC_CHANNELS.DATABASE_HEALTH),
    ])
    setDbStats(stats)
    setTokenStats(tokens)
    setTokenGroupData(groupData)
    if (health) setDbHealth({ pageCount: health.pageCount, freelistPages: health.freelistPages })
    setFastLoading(false)
    return { stats, tokens, groupData }
  }, [])

  // ── Load slow data (tools + skills + trends) ─────────────────────
  const loadSlowData = useCallback(async (tr: TimeRange | undefined) => {
    setSlowLoading(true)
    const [tools, skills, trendComp] = await Promise.all([
      invokeSafe<ToolRanking[]>(IPC_CHANNELS.DASHBOARD_TOOL_RANKING, tr),
      invokeSafe<SkillUsage[]>(IPC_CHANNELS.DASHBOARD_SKILL_USAGE, tr),
      invokeSafe<TrendComparison>(IPC_CHANNELS.DASHBOARD_TRENDS, tr),
    ])
    setToolRanking(tools ?? [])
    setSkillUsage(skills ?? [])
    setTrendComparison(trendComp)
    setSlowLoading(false)
    return { tools: tools ?? [], skills: skills ?? [], trendComp }
  }, [])

  // ── Load all data with async groups ──────────────────────────────
  const loadAllData = useCallback(async (forceRefresh = false) => {
    // Use cache if available and not forcing refresh
    if (dashboardCache && !forceRefresh) {
      setDbStats(dashboardCache.dbStats)
      setTokenStats(dashboardCache.tokenStats)
      setToolRanking(dashboardCache.toolRanking)
      setSkillUsage(dashboardCache.skillUsage)
      setTrendComparison(dashboardCache.trendComparison)
      setTokenGroupData(dashboardCache.tokenGroupData)
      setTimeRange(dashboardCache.timeRange)
      setTimePreset(dashboardCache.timePreset)
      setGroupBy(dashboardCache.groupBy)
      setFastLoading(false)
      setSlowLoading(false)
      return
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
        trendComparison: slowResult.trendComp,
        timeRange,
        timePreset,
        groupBy,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to load dashboard data')
    }
  }, [loadFastData, loadSlowData, timeRange, groupBy])

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
        trendComparison: slowResult.trendComp,
        timeRange,
        timePreset,
        groupBy,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to refresh dashboard data')
    } finally {
      setRefreshing(false)
    }
  }, [loadFastData, loadSlowData, timeRange, groupBy])

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
        setTrendComparison(dashboardCache.trendComparison)
        setTimeRange(dashboardCache.timeRange)
        setTimePreset(dashboardCache.timePreset)
        setGroupBy(dashboardCache.groupBy)
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
  const trendData = useMemo(() => {
    if (!trendComparison?.current) return []
    return trendComparison.current.map((t) => ({
      ...t,
      date: t.date.slice(5), // "MM-DD"
    }))
  }, [trendComparison])

  const previousTrendData = useMemo(() => {
    if (!trendComparison?.previous || !showComparison) return []
    return trendComparison.previous.map((t) => ({
      ...t,
      date: t.date.slice(5),
    }))
  }, [trendComparison, showComparison])

  // Merge current + previous for Recharts
  const mergedTrendData = useMemo(() => {
    if (previousTrendData.length === 0) return trendData
    // Build a map from date to previous values
    const prevMap = new Map(previousTrendData.map((p) => [p.date, p]))
    return trendData.map((cur) => {
      const prev = prevMap.get(cur.date)
      return {
        date: cur.date,
        newSessions: cur.newSessions,
        sizeGrowth: cur.sizeGrowth,
        prevNewSessions: prev?.newSessions ?? 0,
        prevSizeGrowth: prev?.sizeGrowth ?? 0,
      }
    })
  }, [trendData, previousTrendData])

  // ── Time range change handler ──────────────────────────────────
  const handleTimePresetChange = useCallback((days: TimePreset) => {
    setTimePreset(days)
    const tr = computeTimeRange(days)
    setTimeRange(tr)
    dashboardCache = null
  }, [])

  // ── GroupBy change handler ─────────────────────────────────────
  const handleGroupByChange = useCallback((gb: GroupBy) => {
    setGroupBy(gb)
    dashboardCache = null
  }, [])

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
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Dashboard</h2>
          {dbPath && (
            <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[500px]" title={dbPath}>
              {dbPath}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center">
            <button
              onClick={handleVacuum}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-brand-600 border border-brand-300 rounded-md hover:bg-brand-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading === 'vacuum' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              一键 VACUUM
            </button>
            <TooltipHint text={'清理数据库碎片，回收已删除数据占用的空间\n\n适用场景：删除会话/消息后，数据库文件未变小时'} />
          </div>
          <div className="flex items-center">
            <button
              onClick={handleCheckpoint}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-amber-600 border border-amber-300 rounded-md hover:bg-amber-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading === 'checkpoint' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <FileCheck size={14} />
              )}
              WAL Checkpoint
            </button>
            <TooltipHint text={'将待写入的变更合并到主数据库\n\n适用场景：备份前执行，或 WAL 文件过大时'} />
          </div>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-green-600 border border-green-300 rounded-md hover:bg-green-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            刷新
          </button>
        </div>
      </div>

      {/* ── ROW 2: 数据库概览 + 4卡片 ────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 font-medium mb-2">📊 数据库概览</p>
        {fastLoading && !dbStats ? (
          <div className="grid grid-cols-4 gap-4">
            {[1,2,3,4].map(i => (
              <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 h-24 animate-pulse">
                <div className="h-3 bg-gray-200 rounded w-16 mb-3" />
                <div className="h-6 bg-gray-200 rounded w-24" />
              </div>
            ))}
          </div>
        ) : dbStats && (
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
                <p className="text-xs text-gray-400 mt-0.5">{dbHealth.freelistPages} 碎片页</p>
              )}
            </StatCard>
          </div>
        )}
      </div>

      {/* ── ROW 3: 时间范围 ────────────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 font-medium mb-2">⏱ 时间范围</p>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
            {(['all', 7, 30, 90] as TimePreset[]).map((days) => (
              <button
                key={days}
                onClick={() => handleTimePresetChange(days)}
                className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                  timePreset === days
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {days === 'all' ? '全部' : `${days}天`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── ROW 4: 时段统计 + 4卡片 ──────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 font-medium mb-2">📈 时段统计</p>
        {fastLoading && !tokenStats ? (
          <div className="grid grid-cols-4 gap-4">
            {[1,2,3,4].map(i => (
              <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 h-24 animate-pulse">
                <div className="h-3 bg-gray-200 rounded w-16 mb-3" />
                <div className="h-6 bg-gray-200 rounded w-24" />
              </div>
            ))}
          </div>
        ) : dbStats && tokenStats && (
          <div className="grid grid-cols-4 gap-4">
            <StatCard
              label="会话数"
              value={formatNumber(dbStats.sessionCount)}
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
        )}
      </div>

      {/* ── ROW 5: Token 分布 + 增长趋势 ────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 font-medium mb-2">📊 Token 分析 & 增长趋势</p>
        <div className="grid grid-cols-2 gap-4">
          {/* Token Panel */}
          <div className="bg-white rounded-lg border border-gray-200 p-5 relative">
            {fastLoading && !tokenStats && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/60 rounded-lg z-10">
                <Loader2 size={20} className="text-brand-400 animate-spin" />
              </div>
            )}
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-700">Token 分布</h3>
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
            {tokenGroupData.length > 0 && (
              <div className="mt-4 h-48">
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
            )}
          </div>

          {/* Growth Trend */}
          <div className="bg-white rounded-lg border border-gray-200 p-5 relative">
            {slowLoading && !trendData.length && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/60 rounded-lg z-10">
                <Loader2 size={20} className="text-brand-400 animate-spin" />
              </div>
            )}
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-gray-700">增长趋势{timePreset === 'all' ? '' : ` (近${timePreset}天)`}</h3>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500">对比上期</span>
                <input
                  type="checkbox"
                  checked={showComparison}
                  onChange={(e) => setShowComparison(e.target.checked)}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
              </label>
            </div>
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <LineChart
                  data={mergedTrendData}
                  margin={{ left: 0, right: 0, top: 5, bottom: 5 }}
                  onClick={(payload) => {
                    if (payload?.activePayload?.length) {
                      const data = payload.activePayload[0].payload
                      const fullDate = trendComparison?.current.find(
                        (t) => t.date.slice(5) === data.date
                      )?.date
                      if (fullDate) {
                        navigate(`/sessions?start=${fullDate}&end=${fullDate}`)
                      }
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    stroke="#9ca3af"
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 10 }}
                    stroke="#9ca3af"
                    label={{
                      value: '会话数',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 10, fill: '#6b7280' },
                    }}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 10 }}
                    stroke="#9ca3af"
                    label={{
                      value: '数据增长',
                      angle: 90,
                      position: 'insideRight',
                      style: { fontSize: 10, fill: '#6b7280' },
                    }}
                    tickFormatter={(v: number) => formatBytes(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: '12px',
                      borderRadius: '8px',
                      border: '1px solid #e5e7eb',
                    }}
                    labelStyle={{ fontWeight: 600 }}
                    formatter={(value: number, name: string) => {
                      if (name === 'sizeGrowth' || name === 'prevSizeGrowth') return [formatBytes(value), name === 'sizeGrowth' ? '数据增长' : '上期数据增长']
                      if (name === 'newSessions' || name === 'prevNewSessions') return [value, name === 'newSessions' ? '新会话' : '上期新会话']
                      return [value, name]
                    }}
                  />
                  <Legend
                    formatter={(value: string) => {
                      if (value === 'newSessions') return '新会话'
                      if (value === 'sizeGrowth') return '数据增长'
                      if (value === 'prevNewSessions') return '上期新会话'
                      if (value === 'prevSizeGrowth') return '上期数据增长'
                      return value
                    }}
                    wrapperStyle={{ fontSize: 11 }}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="newSessions"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="sizeGrowth"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                  {showComparison && (
                    <>
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="prevNewSessions"
                        stroke="#9ca3af"
                        strokeWidth={1.5}
                        strokeDasharray="5 5"
                        dot={false}
                        activeDot={{ r: 2 }}
                      />
                      <Line
                        yAxisId="right"
                        type="monotone"
                        dataKey="prevSizeGrowth"
                        stroke="#d1d5db"
                        strokeWidth={1.5}
                        strokeDasharray="5 5"
                        dot={false}
                        activeDot={{ r: 2 }}
                      />
                    </>
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-gray-400 text-center py-8">暂无趋势数据</p>
            )}
          </div>
        </div>
      </div>

      {/* ── ROW 6: 技能分布 + 工具排行 ─────────────────────────────── */}
      <div>
        <p className="text-xs text-gray-400 font-medium mb-2">🔧 工具 & 技能排行</p>
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
              <ResponsiveContainer width="100%" height={260}>
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
              <ResponsiveContainer width="100%" height={260}>
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
