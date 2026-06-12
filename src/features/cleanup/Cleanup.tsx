import { useEffect, useState, useRef, useCallback } from 'react'
import type { CleanupPreviewDTO, CleanupFilter, CleanupResultDTO, CleanupStrategy } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatNumber } from '../../lib/format'
import PageHeader from '../../components/PageHeader'
import { Shield, AlertTriangle, Check, Clock, HardDrive, FolderOpen, Code, ChevronRight, ChevronLeft, Trash2, RotateCcw } from 'lucide-react'

type WizardStep = 1 | 2 | 3

const STRATEGY_OPTIONS: { value: CleanupStrategy; label: string; icon: typeof Clock; description: string }[] = [
  { value: 'time', label: '按时间', icon: Clock, description: '删除指定天数前的旧会话' },
  { value: 'size', label: '按大小', icon: HardDrive, description: '删除数据量超过阈值的会话' },
  { value: 'project', label: '按项目', icon: FolderOpen, description: '删除指定项目的所有会话' },
  { value: 'custom', label: '自定义', icon: Code, description: '使用自定义 SQL WHERE 条件' },
]

function Cleanup() {
  // Wizard step
  const [step, setStep] = useState<WizardStep>(1)

  // Strategy form state
  const [strategy, setStrategy] = useState<CleanupStrategy>('time')
  const [days, setDays] = useState(90)
  const [sizeMB, setSizeMB] = useState(50)
  const [projectId, setProjectId] = useState('')
  const [customWhere, setCustomWhere] = useState('')
  const [projects, setProjects] = useState<string[]>([])

  // Preview state
  const [preview, setPreview] = useState<CleanupPreviewDTO | null>(null)
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set())
  const [loadingPreview, setLoadingPreview] = useState(false)

  // Execute state
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<CleanupResultDTO | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [countdown, setCountdown] = useState(3)
  const [actionError, setActionError] = useState<string | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load projects on mount
  useEffect(() => {
    invokeSafe<string[]>(IPC_CHANNELS.SESSIONS_PROJECTS)
      .then((res) => {
        setProjects(res)
      })
      .catch(() => setProjects([]))
  }, [])

  // Build filter from current state
  const buildFilter = useCallback((): CleanupFilter => {
    const filter: CleanupFilter = { strategy }
    switch (strategy) {
      case 'time':
        filter.days = days
        break
      case 'size':
        filter.sizeMB = sizeMB
        break
      case 'project':
        filter.projectId = projectId
        break
      case 'custom':
        filter.customWhere = customWhere
        break
    }
    if (excludedIds.size > 0) {
      filter.excludedSessionIds = [...excludedIds]
    }
    return filter
  }, [strategy, days, sizeMB, projectId, customWhere, excludedIds])

  // Check if strategy form is valid
  const isStrategyValid = (): boolean => {
    switch (strategy) {
      case 'time':
        return days > 0
      case 'size':
        return sizeMB > 0
      case 'project':
        return projectId.length > 0
      case 'custom':
        return customWhere.trim().length > 0
      default:
        return false
    }
  }

  // Step 1 -> Step 2: Load preview
  const handleNextToPreview = async () => {
    if (!isStrategyValid()) return
    setLoadingPreview(true)
    setActionError(null)
    setExcludedIds(new Set())
    try {
      const filter = buildFilter()
      // Clear excludedIds for the initial preview
      const previewFilter: CleanupFilter = { ...filter, excludedSessionIds: [] }
      const res = await invokeSafe<CleanupPreviewDTO>(IPC_CHANNELS.CLEANUP_PREVIEW, previewFilter)
      setPreview(res)
      setStep(2)
    } catch (err) {
      console.error('Failed to load preview:', err)
      setActionError((err as Error).message || '加载预览失败')
    } finally {
      setLoadingPreview(false)
    }
  }

  // Toggle session exclusion
  const toggleExclusion = (sessionId: string) => {
    setExcludedIds(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  // Recalculate summary when exclusions change
  const getAdjustedSummary = () => {
    if (!preview) return null
    const includedSessions = preview.sessions.filter(s => !excludedIds.has(s.id))
    const sessionCount = includedSessions.length
    const messageCount = includedSessions.reduce((sum, s) => sum + s.msg_count, 0)
    const estimatedSize = includedSessions.reduce((sum, s) => sum + s.data_size, 0)
    // Part count is not directly available per session, estimate proportionally
    const partRatio = preview.sessionCount > 0 ? preview.partCount / preview.sessionCount : 0
    const partCount = Math.round(sessionCount * partRatio)
    return { sessionCount, messageCount, partCount, estimatedSize }
  }

  // Step 2 -> Step 3: Confirm
  const handleNextToConfirm = () => {
    setConfirmed(false)
    setCountdown(3)
    setStep(3)

    // Start countdown
    if (countdownRef.current) clearInterval(countdownRef.current)
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  // Cleanup countdown on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [])

  // Execute cleanup
  const handleExecute = async () => {
    if (!confirmed || countdown > 0) return
    setExecuting(true)
    setActionError(null)
    try {
      const filter = buildFilter()
      const res = await invokeSafe<CleanupResultDTO>(IPC_CHANNELS.CLEANUP_EXECUTE, filter)
      setResult(res)
    } catch (err) {
      console.error('Cleanup failed:', err)
      setActionError((err as Error).message || '清理操作失败')
    } finally {
      setExecuting(false)
    }
  }

  // Reset wizard
  const handleReset = () => {
    setStep(1)
    setPreview(null)
    setExcludedIds(new Set())
    setResult(null)
    setConfirmed(false)
    setCountdown(3)
    if (countdownRef.current) clearInterval(countdownRef.current)
  }

  const summary = getAdjustedSummary()

  // ==================== STEP 1: Strategy Selection ====================
  const renderStep1 = () => (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h3 className="text-lg font-medium text-gray-900 mb-1">选择清理策略</h3>
        <p className="text-sm text-gray-500">选择一种策略来筛选需要清理的会话数据</p>
      </div>

      <div className="space-y-3 mb-8">
        {STRATEGY_OPTIONS.map(({ value, label, icon: Icon, description }) => (
          <label
            key={value}
            className={`flex items-start gap-4 p-4 rounded-lg border-2 cursor-pointer transition-all ${
              strategy === value
                ? 'border-brand-500 bg-brand-50'
                : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            <input
              type="radio"
              name="strategy"
              value={value}
              checked={strategy === value}
              onChange={() => setStrategy(value)}
              className="mt-1"
            />
            <Icon size={20} className={strategy === value ? 'text-brand-600' : 'text-gray-400'} />
            <div className="flex-1">
              <div className="font-medium text-gray-900">{label}</div>
              <div className="text-sm text-gray-500">{description}</div>
              {strategy === value && (
                <div className="mt-3">
                  {value === 'time' && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-700">删除</span>
                      <input
                        type="number"
                        min={1}
                        value={days}
                        onChange={e => setDays(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-20 px-2 py-1 border border-gray-300 rounded text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <span className="text-gray-700">天前的会话</span>
                    </div>
                  )}
                  {value === 'size' && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-700">删除大于</span>
                      <input
                        type="number"
                        min={1}
                        value={sizeMB}
                        onChange={e => setSizeMB(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-20 px-2 py-1 border border-gray-300 rounded text-center focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <span className="text-gray-700">MB 的会话</span>
                    </div>
                  )}
                  {value === 'project' && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-700">选择项目</span>
                      <select
                        value={projectId}
                        onChange={e => setProjectId(e.target.value)}
                        className="flex-1 max-w-xs px-2 py-1 border border-gray-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                      >
                        <option value="">-- 请选择项目 --</option>
                        {projects.map(p => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {value === 'custom' && (
                    <div className="text-sm">
                      <span className="text-gray-700 block mb-1">WHERE 条件</span>
                      <input
                        type="text"
                        value={customWhere}
                        onChange={e => setCustomWhere(e.target.value)}
                        placeholder="例如: s.time_created < 1700000000000"
                        className="w-full px-3 py-2 border border-gray-300 rounded font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <p className="mt-1 text-xs text-gray-400">
                        表别名: s=session, 使用 s. 前缀引用 session 表字段
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </label>
        ))}
      </div>

      <div className="flex justify-end">
        {actionError && step === 1 && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 mr-4">
            <AlertTriangle size={16} className="shrink-0" />
            {actionError}
          </div>
        )}
        <button
          onClick={handleNextToPreview}
          disabled={!isStrategyValid() || loadingPreview}
          className="flex items-center gap-2 px-6 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loadingPreview ? '加载中...' : (
            <>
              下一步: 预览
              <ChevronRight size={16} />
            </>
          )}
        </button>
      </div>
    </div>
  )

  // ==================== STEP 2: Preview ====================
  const renderStep2 = () => {
    if (!preview) return null

    return (
      <div>
        <div className="mb-6">
          <h3 className="text-lg font-medium text-gray-900 mb-1">预览清理范围</h3>
          <p className="text-sm text-gray-500">查看将要删除的数据，可以取消勾选不需要删除的会话</p>
        </div>

        {/* Impact summary cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="text-sm text-red-600 mb-1">将删除会话</div>
            <div className="text-2xl font-bold text-red-700">{formatNumber(summary?.sessionCount ?? 0)}</div>
          </div>
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
            <div className="text-sm text-orange-600 mb-1">共消息</div>
            <div className="text-2xl font-bold text-orange-700">{formatNumber(summary?.messageCount ?? 0)}</div>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="text-sm text-yellow-600 mb-1">共 Part</div>
            <div className="text-2xl font-bold text-yellow-700">{formatNumber(summary?.partCount ?? 0)}</div>
          </div>
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <div className="text-sm text-purple-600 mb-1">预计释放</div>
            <div className="text-2xl font-bold text-purple-700">{formatBytes(summary?.estimatedSize ?? 0)}</div>
          </div>
        </div>

        {/* Warning */}
        <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mb-6 text-sm text-amber-800">
          <AlertTriangle size={16} className="shrink-0" />
          <span>建议执行前先备份数据库</span>
        </div>

        {/* Session list */}
        {preview.sessions.length > 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-6">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">
                会话列表 ({preview.sessions.length - excludedIds.size} / {preview.sessions.length} 已选中)
              </span>
              <button
                onClick={() => {
                  if (excludedIds.size === preview.sessions.length) {
                    setExcludedIds(new Set())
                  } else {
                    setExcludedIds(new Set(preview.sessions.map(s => s.id)))
                  }
                }}
                className="text-xs text-brand-600 hover:text-brand-800"
              >
                {excludedIds.size === preview.sessions.length ? '全选' : '全不选'}
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 w-10"></th>
                    <th className="text-left px-4 py-2 font-medium text-gray-500">会话标题</th>
                    <th className="text-right px-4 py-2 font-medium text-gray-500 w-28">数据大小</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sessions.map(session => {
                    const excluded = excludedIds.has(session.id)
                    return (
                      <tr
                        key={session.id}
                        className={`border-b border-gray-100 ${excluded ? 'bg-gray-50 opacity-60' : 'hover:bg-gray-50'}`}
                      >
                        <td className="px-4 py-2">
                          <input
                            type="checkbox"
                            checked={!excluded}
                            onChange={() => toggleExclusion(session.id)}
                          />
                        </td>
                        <td className="px-4 py-2 text-gray-900 max-w-md truncate">
                          {session.title || '无标题'}
                          {session.project_id && (
                            <span className="ml-2 text-xs text-gray-400">({session.project_id})</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-gray-600">
                          {formatBytes(session.data_size)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500 mb-6">
            没有匹配的会话
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between">
          <button
            onClick={() => setStep(1)}
            className="flex items-center gap-2 px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <ChevronLeft size={16} />
            返回修改
          </button>
          <button
            onClick={handleNextToConfirm}
            disabled={!summary || summary.sessionCount === 0}
            className="flex items-center gap-2 px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            确认清理
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    )
  }

  // ==================== STEP 3: Confirm & Execute ====================
  const renderStep3 = () => {
    if (result) {
      return (
        <div className="max-w-lg mx-auto">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
              <Check size={32} className="text-green-600" />
            </div>
            <h3 className="text-xl font-semibold text-gray-900">清理完成</h3>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
            <h4 className="font-medium text-gray-900 mb-4">清理结果</h4>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">删除会话数</span>
                <span className="font-medium text-gray-900">{formatNumber(result.deletedSessions)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">删除消息数</span>
                <span className="font-medium text-gray-900">{formatNumber(result.deletedMessages)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">删除 Part 数</span>
                <span className="font-medium text-gray-900">{formatNumber(result.deletedParts)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">实际释放空间</span>
                <span className="font-medium text-gray-900">{formatBytes(result.freedBytes)}</span>
              </div>
              <div className="border-t border-gray-200 pt-3 mt-3">
                <h5 className="font-medium text-gray-900 mb-2">VACUUM 结果</h5>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">清理前</span>
                    <span className="font-medium text-gray-900">{formatBytes(result.vacuumBefore)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">清理后</span>
                    <span className="font-medium text-gray-900">{formatBytes(result.vacuumAfter)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">回收空间</span>
                    <span className="font-medium text-green-600">{formatBytes(result.vacuumBefore - result.vacuumAfter)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-center">
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
            >
              <RotateCcw size={16} />
              返回首页
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="max-w-lg mx-auto">
        <div className="mb-6">
          <h3 className="text-lg font-medium text-gray-900 mb-1">确认清理</h3>
          <p className="text-sm text-gray-500">请仔细确认清理范围，此操作不可逆</p>
        </div>

        {/* Final summary */}
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
          <h4 className="font-medium text-gray-900 mb-4">清理范围</h4>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">策略</span>
              <span className="font-medium text-gray-900">
                {STRATEGY_OPTIONS.find(o => o.value === strategy)?.label}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">条件</span>
              <span className="font-medium text-gray-900">
                {strategy === 'time' && `${days} 天前`}
                {strategy === 'size' && `大于 ${sizeMB} MB`}
                {strategy === 'project' && projectId}
                {strategy === 'custom' && customWhere}
              </span>
            </div>
            <div className="border-t border-gray-200 pt-3">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">将删除会话</span>
                <span className="font-medium text-red-600">{formatNumber(summary?.sessionCount ?? 0)} 个</span>
              </div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">关联消息</span>
                <span className="font-medium text-gray-900">{formatNumber(summary?.messageCount ?? 0)} 条</span>
              </div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">关联 Part</span>
                <span className="font-medium text-gray-900">{formatNumber(summary?.partCount ?? 0)} 个</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">预计释放</span>
                <span className="font-medium text-gray-900">{formatBytes(summary?.estimatedSize ?? 0)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Danger warning */}
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-lg mb-6">
          <AlertTriangle size={20} className="text-red-600 shrink-0" />
          <div>
            <div className="font-medium text-red-800">此操作不可逆！</div>
            <div className="text-sm text-red-600">删除的数据将无法恢复，请确保已备份数据库</div>
          </div>
        </div>

        {actionError && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg mb-6 text-sm text-red-800">
            <AlertTriangle size={16} className="shrink-0" />
            {actionError}
          </div>
        )}

        {/* Confirmation checkbox */}
        <label className="flex items-center gap-3 p-4 bg-white border border-gray-200 rounded-lg mb-6 cursor-pointer hover:bg-gray-50">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-gray-700">我已确认备份了数据库</span>
        </label>

        {/* Navigation */}
        <div className="flex justify-between">
          <button
            onClick={() => {
              setStep(2)
              setConfirmed(false)
              setCountdown(3)
              if (countdownRef.current) clearInterval(countdownRef.current)
            }}
            disabled={executing}
            className="flex items-center gap-2 px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <ChevronLeft size={16} />
            返回修改
          </button>
          <button
            onClick={handleExecute}
            disabled={!confirmed || countdown > 0 || executing}
            className="flex items-center gap-2 px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {executing ? (
              <>
                <Trash2 size={16} className="animate-pulse" />
                正在清理...
              </>
            ) : countdown > 0 ? (
              <>
                <Shield size={16} />
                确认清理 ({countdown}s)
              </>
            ) : (
              <>
                <Trash2 size={16} />
                确认清理
              </>
            )}
          </button>
        </div>
      </div>
    )
  }

  // ==================== Step indicator ====================
  const stepLabels = ['选择策略', '预览范围', '确认执行']
  const stepIcons = [Shield, HardDrive, Trash2]

  return (
    <div className="p-6 h-full flex flex-col">
      <PageHeader
        icon={<Trash2 size={24} />}
        title="清理向导"
      />

      {/* Step indicator */}
      {!result && (
        <div className="flex items-center justify-center mb-8">
          {stepLabels.map((label, idx) => {
            const stepNum = (idx + 1) as WizardStep
            const StepIcon = stepIcons[idx]
            const isActive = step === stepNum
            const isCompleted = step > stepNum
            return (
              <div key={label} className="flex items-center">
                <div className="flex flex-col items-center">
                  <div
                    className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-all ${
                      isCompleted
                        ? 'bg-brand-600 border-brand-600 text-white'
                        : isActive
                          ? 'bg-brand-50 border-brand-500 text-brand-600'
                          : 'bg-gray-100 border-gray-300 text-gray-400'
                    }`}
                  >
                    {isCompleted ? <Check size={18} /> : <StepIcon size={18} />}
                  </div>
                  <span
                    className={`mt-1.5 text-xs font-medium ${
                      isActive ? 'text-brand-600' : isCompleted ? 'text-brand-600' : 'text-gray-400'
                    }`}
                  >
                    {label}
                  </span>
                </div>
                {idx < stepLabels.length - 1 && (
                  <div
                    className={`w-20 h-0.5 mx-2 mb-5 ${
                      isCompleted ? 'bg-brand-600' : 'bg-gray-300'
                    }`}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Step content */}
      <div className="flex-1 overflow-auto">
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </div>
    </div>
  )
}

export default Cleanup
