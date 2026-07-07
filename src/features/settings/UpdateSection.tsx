/**
 * 设置页 - 版本更新区
 * 展示当前版本 + 上次检查时间 + 检查更新按钮
 */
import { useUpdateStatus } from '@/features/update/useUpdateStatus'
import { RefreshCw, Loader2, CheckCircle2 } from 'lucide-react'

export function UpdateSection() {
  const { state, info, error, isChecking, check } = useUpdateStatus()

  return (
    <section className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">版本更新</h2>
      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">当前版本</span>
          <span className="text-gray-900 font-medium">v1.2.1</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">最新版本</span>
          <span className="text-gray-900 font-medium">
            {info ? `v${info.version}` : '—'}
          </span>
        </div>
        {error && (
          <div className="text-red-600 text-xs bg-red-50 p-2 rounded">{error.message}</div>
        )}
        <button
          onClick={check}
          disabled={isChecking || state === 'downloading' || state === 'installing'}
          className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
        >
          {isChecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {isChecking ? '检查中...' : '检查更新'}
        </button>
        {state === 'available' && (
          <div className="flex items-center gap-2 text-brand-600 text-xs">
            <CheckCircle2 size={14} />
            <span>发现新版本,请到更新弹窗查看</span>
          </div>
        )}
      </div>
    </section>
  )
}
