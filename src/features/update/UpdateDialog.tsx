/**
 * 版本更新弹窗
 * 状态机驱动的弹窗 UI:
 *   - available: 展示版本信息 + 「立即更新」按钮
 *   - downloading: 展示进度条
 *   - downloaded: 展示「立即安装」按钮
 *   - installing: 展示"正在安装"文案
 *   - idle: 不渲染
 */
import { useUpdateStatus } from './useUpdateStatus'
import Modal from '@/components/Modal'
import { Download, Package, Loader2 } from 'lucide-react'

export function UpdateDialog() {
  const { state, info, progress, error, download, install } = useUpdateStatus()
  if (state === 'idle') return null
  if (!info) return null

  return (
    <Modal isOpen onClose={() => { /* 用户不可关闭,必须走更新流程 */ }} title="版本更新">
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <Package size={20} className="text-brand-600 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-gray-900">
              发现新版本 <span className="font-semibold">v{info.version}</span>
            </p>
            <p className="text-xs text-gray-500 mt-1">
              发布于 {new Date(info.releaseDate).toLocaleDateString('zh-CN')}
            </p>
          </div>
        </div>

        {info.releaseNotes && (
          <div className="bg-gray-50 rounded p-3 max-h-48 overflow-y-auto text-xs text-gray-700">
            <pre className="whitespace-pre-wrap font-sans">{info.releaseNotes}</pre>
          </div>
        )}

        {state === 'available' && (
          <button
            onClick={download}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors"
          >
            <Download size={16} />
            立即下载
          </button>
        )}

        {state === 'downloading' && progress && (
          <div className="space-y-2">
            <div className="h-2 bg-gray-200 rounded overflow-hidden">
              <div
                className="h-full bg-brand-600 transition-all"
                style={{ width: `${progress.percent.toFixed(0)}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 text-center">
              {progress.percent.toFixed(0)}% · {(progress.transferred / 1024 / 1024).toFixed(1)} MB / {(progress.total / 1024 / 1024).toFixed(1)} MB
            </p>
          </div>
        )}

        {state === 'downloaded' && (
          <button
            onClick={install}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors"
          >
            <Download size={16} />
            立即安装
          </button>
        )}

        {state === 'installing' && (
          <div className="flex items-center justify-center gap-2 py-2 text-sm text-gray-600">
            <Loader2 size={16} className="animate-spin" />
            正在准备安装,App 即将退出...
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-700 text-xs p-2 rounded">
            {error.message}
          </div>
        )}
      </div>
    </Modal>
  )
}
