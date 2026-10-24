/**
 * 版本更新弹窗
 * 状态机驱动的弹窗 UI:
 *   - available: 展示版本信息 + 「立即下载」按钮
 *   - downloading: 展示进度条（真实进度事件）
 *   - downloaded: 展示「立即安装」按钮
 *   - installing: 展示「正在安装」文案
 *   - 关闭弹窗不会丢弃「有更新」的结论，设置页仍可继续更新
 */
import { useUpdateStatus } from './useUpdateStatus'
import { canRetryUpdate } from './errorClassifier'
import { useOpenReleasePage } from './releasePage'
import Modal from '@/components/Modal'
import { Download, Package, Loader2, ShieldAlert, ExternalLink } from 'lucide-react'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小'
  const mb = bytes / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

export function UpdateDialog() {
  const { dialogOpen, state, info, progress, error, download, install, dismissDialog } = useUpdateStatus()
  const openReleasePage = useOpenReleasePage()
  if (!dialogOpen) return null
  if (!info) return null

  // 只有拿到 Content-Length 才展示百分比，否则百分比会是一个假数字。
  const hasKnownTotal = !!progress && progress.total > 0
  const percent = hasKnownTotal ? Math.round(progress!.percent) : null

  // 下载 / 安装进行中不允许关闭弹窗：× 按钮会置灰，Esc 与遮罩点击同样无效。
  const closeDisabled = state === 'downloading' || state === 'installing'

  // 签名不匹配 / 本平台无产物时，重试必然同样失败：不再给「立即下载」入口。
  const retryAllowed = canRetryUpdate(error)

  return (
    <Modal isOpen onClose={dismissDialog} title="版本更新" closeDisabled={closeDisabled}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <Package size={20} className="text-brand-800 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-900">
              发现新版本 <span className="font-semibold whitespace-nowrap tabular-nums">v{info.version}</span>
            </p>
            {info.releaseDate && (
              <p className="text-xs text-gray-500 mt-1">
                发布于 {new Date(info.releaseDate).toLocaleDateString('zh-CN')}
              </p>
            )}
          </div>
        </div>

        {info.releaseNotes && (
          <div className="bg-gray-50 rounded p-3 max-h-48 overflow-y-auto text-xs text-gray-700">
            <pre className="whitespace-pre-wrap font-sans">{info.releaseNotes}</pre>
          </div>
        )}

        {state === 'available' && retryAllowed && (
          <button
            onClick={download}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-brand-800 text-white hover:bg-brand-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <Download size={16} aria-hidden="true" />
            立即下载
          </button>
        )}

        {/* 重试无意义时（签名不符 / 本平台无产物）：只给发布页入口，不再给会再次失败的下载入口 */}
        {!retryAllowed && (
          <button
            onClick={() => { void openReleasePage() }}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-brand-800 text-white hover:bg-brand-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <ExternalLink size={16} aria-hidden="true" />
            打开发布页
          </button>
        )}

        {state === 'downloading' && (
          <div className="space-y-2">
            <div
              role="progressbar"
              aria-label="更新包下载进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              aria-valuetext={percent === null ? '正在下载' : `${percent}%`}
              aria-live="off"
              className="h-2 bg-gray-200 rounded overflow-hidden"
            >
              <div
                className="h-full bg-brand-800 transition-all"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
            <p className="text-xs text-gray-600 text-center">
              {percent === null
                ? `已下载 ${formatBytes(progress?.transferred ?? 0)}`
                : `${percent}% · ${formatBytes(progress?.transferred ?? 0)} / ${formatBytes(progress?.total ?? 0)}`}
            </p>
          </div>
        )}

        {state === 'downloaded' && (
          <button
            onClick={install}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-brand-800 text-white hover:bg-brand-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <Download size={16} aria-hidden="true" />
            立即安装
          </button>
        )}

        {state === 'installing' && (
          <div className="flex items-center justify-center gap-2 py-2 text-sm text-gray-700">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            正在安装并重启应用，请稍候…
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-700 text-xs p-2 rounded flex items-start gap-2">
            <ShieldAlert size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>{error.message}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
