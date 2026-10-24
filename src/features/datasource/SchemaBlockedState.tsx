/**
 * SchemaBlockedState —— `unsupported` 时的受限占位块。
 *
 * 实现依据：`04-技术方案/08.1-Schema与迁移状态展示-设计规格.md` 5.1。
 *
 * 关键约束：
 *   - 非全屏遮罩，**不阻断应用其它入口**（设置 / 备份导出仍可用）
 *   - 不显示任何统计数字，避免被误读为「数据被删」
 */
import { AlertTriangle, FolderOpen, Loader2, RefreshCw } from 'lucide-react'

export interface SchemaBlockedStateProps {
  reason?: string | null
  path?: string | null
  refreshing?: boolean
  /** 重新检测 */
  onRetry: () => void
  /** 打开所在目录（可选） */
  onReveal?: () => void
  /** 切换数据源 */
  onSwitch: () => void
}

const DEFAULT_REASON = '缺少 session_message / session_v2 等表'

export function SchemaBlockedState({
  reason,
  path,
  refreshing = false,
  onRetry,
  onReveal,
  onSwitch,
}: SchemaBlockedStateProps) {
  return (
    <div className="flex items-center justify-center py-16 px-4" data-testid="schema-blocked-state">
      <div className="max-w-xl w-full text-center">
        <AlertTriangle aria-hidden="true" size={40} className="mx-auto text-red-400 mb-3" />
        <h3 className="text-base font-medium text-gray-900 mb-1.5">无法读取这个数据库</h3>
        <p className="text-sm text-gray-600 mb-2">
          该文件不是受支持的 OpenCode 数据库格式。为避免误判，这里不显示任何统计数字。
        </p>
        <p className="font-mono text-xs leading-5 text-gray-500 break-all whitespace-pre-wrap mb-1">
          {reason || DEFAULT_REASON}
        </p>
        {path && <p className="font-mono text-xs text-gray-400 break-all mb-4">{path}</p>}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            disabled={refreshing}
            aria-busy={refreshing || undefined}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            {refreshing ? (
              <Loader2 aria-hidden="true" size={14} className="animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw aria-hidden="true" size={14} />
            )}
            {refreshing ? '检测中…' : '重新检测'}
          </button>
          {onReveal && (
            <button
              type="button"
              onClick={onReveal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
            >
              <FolderOpen aria-hidden="true" size={14} />
              打开所在目录
            </button>
          )}
          <button
            type="button"
            onClick={onSwitch}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            切换数据源
          </button>
        </div>
      </div>
    </div>
  )
}

export default SchemaBlockedState
