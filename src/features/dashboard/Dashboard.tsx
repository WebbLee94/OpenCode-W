import { useEffect, useState, useCallback, useRef } from 'react'
import type {
  DatabaseStats,
  TokenStats,
  ToolRanking,
  SkillUsage,
  TrendDataPoint,
} from '@shared/types'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { invoke } from '@/lib/ipc'
import {
  Database,
  MessageSquare,
  Folder,
  Trash2,
  FileText,
  Layers,
  DollarSign,
  Zap,
  RefreshCw,
  Sparkles,
  FileCheck,
  Loader2,
  AlertCircle,
  Unplug,
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

// ── Module-level cache ─────────────────────────────────────────────
interface DashboardCache {
  dbStats: DatabaseStats | null
  tokenStats: TokenStats | null
  toolRanking: ToolRanking[]
  skillUsage: SkillUsage[]
  trends: TrendDataPoint[]
}

let dashboardCache: DashboardCache | null = null

// ── Dashboard ──────────────────────────────────────────────────────
function Dashboard() {
  const [dbStats, setDbStats] = useState<DatabaseStats | null>(dashboardCache?.dbStats ?? null)
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(dashboardCache?.tokenStats ?? null)
  const [toolRanking, setToolRanking] = useState<ToolRanking[]>(dashboardCache?.toolRanking ?? [])
  const [skillUsage, setSkillUsage] = useState<SkillUsage[]>(dashboardCache?.skillUsage ?? [])
  const [trends, setTrends] = useState<TrendDataPoint[]>(dashboardCache?.trends ?? [])

  const [connected, setConnected] = useState(!!dashboardCache)
  const [dbPath, setDbPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(!dashboardCache)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const hasLoadedRef = useRef(!!dashboardCache)

  // ── Load fast data (overview + tokens) ───────────────────────────
  const loadFastData = useCallback(async () => {
    const [stats, tokens] = await Promise.all([
      invoke<DatabaseStats>(IPC_CHANNELS.DASHBOARD_OVERVIEW),
      invoke<TokenStats>(IPC_CHANNELS.DASHBOARD_TOKENS),
    ])
    setDbStats(stats)
    setTokenStats(tokens)
    return { stats, tokens }
  }, [])

  // ── Load slow data (tools + skills + trends) ─────────────────────
  const loadSlowData = useCallback(async () => {
    const [tools, skills, trendData] = await Promise.all([
      invoke<ToolRanking[]>(IPC_CHANNELS.DASHBOARD_TOOL_RANKING),
      invoke<SkillUsage[]>(IPC_CHANNELS.DASHBOARD_SKILL_USAGE),
      invoke<TrendDataPoint[]>(IPC_CHANNELS.DASHBOARD_TRENDS),
    ])
    setToolRanking(tools ?? [])
    setSkillUsage(skills ?? [])
    setTrends(trendData ?? [])
    return { tools: tools ?? [], skills: skills ?? [], trendData: trendData ?? [] }
  }, [])

  // ── Load all data with async groups ──────────────────────────────
  const loadAllData = useCallback(async (forceRefresh = false) => {
    // Use cache if available and not forcing refresh
    if (dashboardCache && !forceRefresh) {
      setDbStats(dashboardCache.dbStats)
      setTokenStats(dashboardCache.tokenStats)
      setToolRanking(dashboardCache.toolRanking)
      setSkillUsage(dashboardCache.skillUsage)
      setTrends(dashboardCache.trends)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      // Fast group first
      const fastResult = await loadFastData()
      setLoading(false)

      // Slow group after
      const slowResult = await loadSlowData()

      // Update cache
      dashboardCache = {
        dbStats: fastResult.stats,
        tokenStats: fastResult.tokens,
        toolRanking: slowResult.tools,
        skillUsage: slowResult.skills,
        trends: slowResult.trendData,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to load dashboard data')
      setLoading(false)
    }
  }, [loadFastData, loadSlowData])

  // ── Refresh handler (force reload) ───────────────────────────────
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const fastResult = await loadFastData()
      const slowResult = await loadSlowData()
      dashboardCache = {
        dbStats: fastResult.stats,
        tokenStats: fastResult.tokens,
        toolRanking: slowResult.tools,
        skillUsage: slowResult.skills,
        trends: slowResult.trendData,
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to refresh dashboard data')
    } finally {
      setRefreshing(false)
    }
  }, [loadFastData, loadSlowData])

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
        setTrends(dashboardCache.trends)
        setConnected(true)
        setLoading(false)
        return
      }
      // No cache — do health check then load data
      try {
        const health = await invoke<{ ok: boolean }>(IPC_CHANNELS.DATABASE_HEALTH)
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
      }
    }
    init()
  }, [loadAllData])

  // ── Connect to a database ────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    try {
      const filePath = await invoke<string | null>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      if (!filePath) return
      const result = await invoke<{ success: boolean; path?: string; error?: string }>(IPC_CHANNELS.DATABASE_OPEN, filePath)
      if (result.success) {
        setConnected(true)
        setDbPath(result.path ?? filePath)
        dashboardCache = null
        await loadAllData(true)
      } else {
        setError(result.error ?? 'Failed to open database')
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }, [loadAllData])

  // ── Vacuum ───────────────────────────────────────────────────────
  const handleVacuum = useCallback(async () => {
    setActionLoading('vacuum')
    try {
      const result = await invoke<{ before: number; after: number; freed: number }>(IPC_CHANNELS.DATABASE_VACUUM)
      alert(`VACUUM 完成! 释放空间: ${formatBytes(result.freed)}`)
      dashboardCache = null
      await loadAllData(true)
    } catch (err) {
      alert(`VACUUM 失败: ${(err as Error).message}`)
    } finally {
      setActionLoading(null)
    }
  }, [loadAllData])

  // ── WAL Checkpoint ───────────────────────────────────────────────
  const handleCheckpoint = useCallback(async () => {
    setActionLoading('checkpoint')
    try {
      await invoke(IPC_CHANNELS.DATABASE_CHECKPOINT)
      alert('WAL Checkpoint 完成!')
      dashboardCache = null
      await loadAllData(true)
    } catch (err) {
      alert(`Checkpoint 失败: ${(err as Error).message}`)
    } finally {
      setActionLoading(null)
    }
  }, [loadAllData])

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
            className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Connect Database
          </button>
        </div>
      </div>
    )
  }

  // ── Loading view ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 size={32} className="mx-auto text-blue-500 animate-spin mb-3" />
          <p className="text-gray-500 text-sm">Loading dashboard data...</p>
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
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
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

  // ── Trend data (last 30 days) ────────────────────────────────────
  const trendData = trends.slice(-30).map((t) => ({
    ...t,
    date: t.date.slice(5), // "MM-DD"
  }))

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
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
          <div className="relative group">
            <button
              onClick={handleVacuum}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading === 'vacuum' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              一键 VACUUM
            </button>
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-2 bg-gray-800 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-pre-line z-50 w-64 text-center shadow-lg">
              清理数据库碎片，回收已删除数据占用的空间{'\n'}{'\n'}适用场景：删除会话/消息后，数据库文件未变小时
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45" />
            </div>
          </div>
          <div className="relative group">
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
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-2 bg-gray-800 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-pre-line z-50 w-64 text-center shadow-lg">
              将待写入的变更合并到主数据库{'\n'}{'\n'}适用场景：备份前执行，或 WAL 文件过大时
              <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45" />
            </div>
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

      {/* ── Overview Cards Row 1 ────────────────────────────────── */}
      {dbStats && (
        <div className="grid grid-cols-4 gap-4">
          <StatCard
            label="总大小"
            value={formatBytes(dbStats.dbSize)}
            icon={<Database size={20} />}
          />
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
            label="可回收碎片"
            value={formatBytes(dbStats.freelistSize)}
            icon={<Trash2 size={20} />}
          />
        </div>
      )}

      {/* ── Overview Cards Row 2 ────────────────────────────────── */}
      {dbStats && tokenStats && (
        <div className="grid grid-cols-4 gap-4">
          <StatCard
            label="WAL日志"
            value={formatBytes(dbStats.walSize)}
            icon={<FileText size={20} />}
          />
          <StatCard
            label="Part行数"
            value={formatNumber(dbStats.partCount)}
            icon={<Layers size={20} />}
          />
          <StatCard
            label="估算成本"
            value={`$${tokenStats.estimatedCost.toFixed(2)}`}
            icon={<DollarSign size={20} />}
          />
          <StatCard
            label="缓存命中率"
            value={`${tokenStats.cacheHitRate.toFixed(1)}%`}
            icon={<Zap size={20} />}
          />
        </div>
      )}

      {/* ── Token Panel + Tool Ranking ──────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        {/* Token Panel */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700 mb-4">Token 分布</h3>
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
                  color="bg-blue-500"
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
                    label="缓存命中率"
                    value={`${tokenStats.cacheHitRate.toFixed(1)}%`}
                    color="bg-amber-500"
                  />
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-8">暂无Token数据</p>
          )}
        </div>

        {/* Tool Ranking */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
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

      {/* ── Skill Usage + Growth Trend ──────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        {/* Skill Usage */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
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

        {/* Growth Trend */}
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700 mb-4">增长趋势 (近30天)</h3>
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={trendData} margin={{ left: 0, right: 0, top: 5, bottom: 5 }}>
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
                    if (name === 'sizeGrowth') return [formatBytes(value), '数据增长']
                    return [value, '新会话']
                  }}
                />
                <Legend
                  formatter={(value: string) => {
                    if (value === 'newSessions') return '新会话'
                    if (value === 'sizeGrowth') return '数据增长'
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
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-gray-400 text-center py-8">暂无趋势数据</p>
          )}
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
