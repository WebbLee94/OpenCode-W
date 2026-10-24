/** LIKE 回退提示等固定文案之外的按库形态引导（B-16）：避免 v1-only / v2-only 用户被「迁移/旧格式」语言误导。 */
const V1_GUIDE_TEXT = 'OpenCode 当前使用旧格式数据库，所有数据为 v1 格式。升级 OpenCode 后迁移会自动开始。'
const V2_CLEAN_GUIDE_TEXT = '当前为 OpenCode v2 数据库，无需迁移或清理旧格式数据。'
const CLEANUP_GUIDE_TEXT = '到清理向导处理旧格式数据'

/**
 * DatabaseModeBadge —— 数据库兼容状态徽标。
 *
 * 实现依据：`04-技术方案/08.1-Schema与迁移状态展示-设计规格.md` 第 2 节。
 *
 * 纯展示组件：不发 IPC，`onRefresh` 由调用方注入。
 * 约束：
 *   - 颜色不作唯一状态载体（图标形状 + 主文案 + 等宽标签至少两个非颜色载体）
 *   - `role="status"` + `aria-live="polite"` + `aria-atomic="true"`
 *   - 图标与圆点 `aria-hidden`，交互按钮放在 live region **之外**
 */
import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  HelpCircle,
  Loader2,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { deriveSchemaState, type DerivedSchemaState, type SchemaUiState } from '@/features/datasource/useSchemaInfo'

export interface DatabaseModeBadgeProps {
  /** 已归一化的状态；null 表示还没拿到任何信息 */
  state: SchemaUiState
  /** 首次检测中（仅无 state 时渲染骨架，不替换已有内容） */
  loading?: boolean
  /** 「刷新状态」进行中：只影响按钮与 aria-busy，不改变状态文案 */
  refreshing?: boolean
  /** 传入则渲染「刷新状态」按钮（仅设置页传） */
  onRefresh?: () => void
  /** 「刷新状态」失败信息，渲染在徽标下方 role="alert" */
  refreshError?: string | null
  /** 额外类名，用于外部控制间距 */
  className?: string
}

interface StateView {
  dotClass: string
  Icon: LucideIcon
  iconClass: string
  titleClass: string
  /** 空字符串表示「无容器」 */
  containerTone: string
  primary: string
  secondary: string
  secondaryClass: string
  /** 等宽技术标签（`mode` 原值，不翻译） */
  tag: string | null
  ariaLabel: string
}

/** 等宽标签样式（全状态一致，规格 2.2） */
const TAG_CLASS = 'font-mono text-[11px] leading-4 px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 shrink-0'

/** 未能识别的默认原因（规格 2.2） */
const DEFAULT_UNSUPPORTED_REASON = '缺少 session_message / session_v2 等表'

function buildView(d: DerivedSchemaState): StateView {
  switch (d.key) {
    case 'loading':
      return {
        dotClass: 'bg-gray-300',
        Icon: Loader2,
        iconClass: 'text-gray-400 animate-spin motion-reduce:animate-none',
        titleClass: 'text-gray-900',
        containerTone: '',
        primary: '正在读取数据库信息',
        secondary: '通常只需一瞬间。',
        secondaryClass: 'text-gray-500',
        tag: null,
        ariaLabel: '数据库状态：正在读取数据库信息。',
      }
    case 'none':
      return {
        dotClass: 'bg-gray-400',
        Icon: HelpCircle,
        iconClass: 'text-gray-400',
        titleClass: 'text-gray-900',
        containerTone: '',
        primary: '未连接数据库',
        secondary: '打开或切换数据源后，这里会显示兼容状态。',
        secondaryClass: 'text-gray-500',
        tag: null,
        ariaLabel: '数据库状态：尚未连接数据库。打开或切换数据源后可查看兼容状态。',
      }
    case 'v1':
      return {
        dotClass: 'bg-gray-400',
        Icon: Database,
        iconClass: 'text-gray-500',
        titleClass: 'text-gray-900',
        containerTone: '',
        primary: '旧版数据库',
        secondary: '功能完整；OpenCode 升级到 v2 后会变成「已适配」。',
        secondaryClass: 'text-gray-500',
        tag: 'v1',
        ariaLabel: '数据库状态：旧版数据库（数据库模式 v1）。功能完整，OpenCode 升级到 v2 后会自动适配。',
      }
    case 'v2': {
      // v2 正常态与 v2-mixed(legacy=0) 的 L1 一致：技术标识统一收进「详情」。
      return {
        dotClass: 'bg-green-500',
        Icon: CheckCircle2,
        iconClass: 'text-green-600',
        titleClass: 'text-gray-900',
        containerTone: '',
        primary: '数据读取正常',
        secondary: '数据读取与清理功能完整。',
        secondaryClass: 'text-gray-500',
        tag: null,
        ariaLabel: '数据库状态：数据读取正常。数据读取与清理功能完整。',
      }
    }
    case 'running':
      return {
        dotClass: 'bg-blue-500',
        Icon: Loader2,
        iconClass: 'text-blue-600 animate-spin motion-reduce:animate-none',
        titleClass: 'text-blue-900',
        containerTone: 'border-blue-200 bg-blue-50',
        primary: '正在迁移数据',
        secondary: '迁移期间只能浏览；清理、删除与恢复已暂停。完成后点「刷新状态」。',
        secondaryClass: 'text-blue-800',
        tag: `${d.mode ?? 'unknown'} · running`,
        ariaLabel: '数据库状态：正在迁移数据。迁移期间只能浏览，清理、删除与恢复已暂停。',
      }
    case 'failed':
      return {
        dotClass: 'bg-red-500',
        Icon: XCircle,
        iconClass: 'text-red-600',
        titleClass: 'text-red-900',
        containerTone: 'border-red-200 bg-red-50',
        primary: '迁移未完成',
        secondary: '请在 OpenCode 中完成迁移。本应用不会修改数据库，也不会代为迁移。',
        secondaryClass: 'text-red-800',
        tag: `${d.mode ?? 'unknown'} · failed`,
        ariaLabel: '数据库状态：迁移未完成。请在 OpenCode 中完成迁移，本应用不会修改数据库。',
      }
    case 'unsupported':
    default:
      return {
        dotClass: 'bg-red-500',
        Icon: AlertTriangle,
        iconClass: 'text-red-600',
        titleClass: 'text-red-900',
        containerTone: 'border-red-200 bg-red-50',
        primary: '无法识别的数据库格式',
        secondary: '该文件缺少受支持的 OpenCode 表结构。本应用未读取也未修改其中数据；仍可导出备份副本。',
        secondaryClass: 'text-red-800',
        tag: 'unsupported',
        ariaLabel: `数据库状态：无法识别的数据库格式。${d.reason || DEFAULT_UNSUPPORTED_REASON}。可以导出备份副本，但无法浏览会话。`,
      }
  }
}

export function DatabaseModeBadge({
  state,
  loading = false,
  refreshing = false,
  onRefresh,
  refreshError = null,
  className,
}: DatabaseModeBadgeProps) {
  const derived = deriveSchemaState(state)
  const view = buildView(derived)
  const key = derived.key

  // ── 迁移疑似停滞提示（规格 2.5 / 6.1）─────────────────────────────
  // 计时起点 = 本窗口首次观察到 running 的时刻；
  // 「刷新状态」返回仍是 running 时**不重置**（重置会掩盖问题）。
  const [runningSince, setRunningSince] = useState<number | null>(null)
  useEffect(() => {
    if (key === 'running') setRunningSince(prev => prev ?? Date.now())
    else setRunningSince(null)
  }, [key])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (runningSince === null) return
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [runningSince])

  const elapsed = runningSince === null ? 0 : now - runningSince
  const stalledNote =
    elapsed >= 30 * 60_000
      ? '迁移已持续 30 分钟以上。建议回到 OpenCode 确认迁移是否仍在进行；本应用不会修改数据库，可继续浏览现有数据。'
      : elapsed >= 5 * 60_000
        ? '迁移已持续 5 分钟以上。大型数据库可能需要更久；可在 OpenCode 中查看进度，完成后点「刷新状态」。'
        : null

  // 原因块：unsupported 常显；running + unsupported 时补一句结构未就绪
  const showReason = key === 'unsupported' || (key === 'running' && derived.mode === 'unsupported')
  const reasonText = derived.reason || DEFAULT_UNSUPPORTED_REASON
  const reason = showReason
    ? key === 'running'
      ? `结构尚未就绪，可能是迁移正在创建新表。\n${reasonText}`
      : reasonText
    : null

  // v2 / v2-mixed 的技术身份：L1 保持中性，细节默认折叠（v2-only 收口）。
  const showDetails = key === 'v1' || key === 'v2'
  const technicalTag = `${derived.mode ?? 'unknown'} · ${derived.phase ?? 'none'}`

  return (
    <div
      className={['space-y-1.5 min-w-0', className].filter(Boolean).join(' ')}
      data-testid="database-mode-badge"
      data-state={key}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={view.ariaLabel}
        aria-busy={loading || refreshing || undefined}
        className={[
          'flex flex-col gap-1 min-w-0',
          view.containerTone === '' ? '' : `rounded-md border px-3 py-2.5 ${view.containerTone}`,
        ].filter(Boolean).join(' ')}
      >
        {/* 第一行：圆点 + 图标 + 主文案 + 等宽标签 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${view.dotClass}`} />
          <view.Icon aria-hidden="true" focusable="false" size={16} className={`shrink-0 ${view.iconClass}`} />
          <span className={`text-sm font-medium ${view.titleClass}`}>{view.primary}</span>
          {view.tag && (
            <span aria-hidden="true" className={TAG_CLASS}>
              {view.tag}
            </span>
          )}
        </div>

        {/* 第二行：辅助说明 */}
        <p className={`text-xs leading-5 break-words ${view.secondaryClass}`}>{view.secondary}</p>

        {/* 第三行：原因（常显、换行、可选中复制，不截断） */}
        {reason && (
          <p className="font-mono text-xs leading-5 text-gray-600 break-all whitespace-pre-wrap select-text">{reason}</p>
        )}

        {/* 第四行：迁移疑似停滞 */}
        {stalledNote && (
          <p className="flex items-start gap-1 text-xs leading-5 text-gray-600">
            <Clock aria-hidden="true" size={12} className="mt-1 shrink-0" />
            <span>{stalledNote}</span>
          </p>
        )}
      </div>

      {/* 详情（B-14 收敛 + B-16 按形态分支）：设置页只保留病史式一句话 + 技术标识；
          旧表/旧副本与各计数等数据明细移到清理向导「回收旧格式内容块」，避免两处不同步。
          v2-only（无旧格式会话且无尾消息）隐藏迁移/旧格式语言；v1 给升级预期。 */}
      {showDetails && (
        <details className="group px-1">
          <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded text-xs text-gray-600 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1">
            详情
          </summary>
          {key === 'v1' && (
            <p className="mt-1.5 text-xs leading-5 text-gray-600">{V1_GUIDE_TEXT}</p>
          )}
          {key === 'v2' && (
            <p className="mt-1.5 text-xs leading-5 text-gray-600">{V2_CLEAN_GUIDE_TEXT}</p>
          )}
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-gray-500">技术标识</dt>
            <dd className="font-mono text-gray-700 break-all">{technicalTag}</dd>
          </dl>
          {/* 纯文本指引：不执行、不显示体积数字；入口在清理向导（B-9） */}
          {key === 'v1' && (
            <p className="mt-1.5 text-xs leading-5 text-gray-600">{CLEANUP_GUIDE_TEXT}</p>
          )}
        </details>
      )}

      {/* 动作区：不放在 role="status" 内，避免读屏把按钮当状态播报 */}
      {(onRefresh || refreshError) && (
        <div className="flex flex-wrap items-center gap-2">
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-busy={refreshing || undefined}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-300 bg-white text-xs text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
            >
              {refreshing ? (
                <Loader2 aria-hidden="true" size={12} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <RefreshCw aria-hidden="true" size={12} />
              )}
              {refreshing ? '刷新中…' : '刷新状态'}
            </button>
          )}
          {refreshError && (
            <p role="alert" className="text-xs text-red-600 break-words">{`刷新状态失败：${refreshError}`}</p>
          )}
        </div>
      )}
    </div>
  )
}

export default DatabaseModeBadge
