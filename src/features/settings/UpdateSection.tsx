/**
 * 设置页 - 版本更新区
 *
 * 展示当前版本 + 可更新版本（仅在确实有更新时出现）+ 检查状态 + 检查更新按钮。
 *
 * 状态文案集中放在 `updateStatus.ts`，与更新弹窗共用同一份字符串，
 * 保证「页面上看到的」和「读屏软件读到的」完全一致。
 */
import { useCallback, useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@/lib/ipc'
import { useUpdateStatus } from '@/features/update/useUpdateStatus'
import { canRetryUpdate } from '@/features/update/errorClassifier'
import { useOpenReleasePage } from '@/features/update/releasePage'
import { formatCheckedAt, resolveUpdateStatus, TONE_TEXT_CLASS } from '@/features/update/updateStatus'
import { useToast } from '@/hooks/useToast'
import { Check, Copy, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import pkg from '../../../package.json'

/**
 * 浏览器预览环境下没有 Tauri 版本号，回落到仓库版本。
 *
 * ⚠️ 这**不是**用户安装的版本，而是仓库构建版本 —— 界面上必须如实标注，
 * 不能让用户把仓库版本当成自己装的那个。
 */
const FALLBACK_VERSION = `v${pkg.version}`

export function UpdateSection() {
  const { state, checkStatus, info, error, isChecking, lastCheckedAt, check, download, install } = useUpdateStatus()
  const { addToast } = useToast()
  const openReleasePage = useOpenReleasePage()
  const tauri = isTauri()
  /** 浏览器预览态：没有真实的桌面端版本号，只能显示仓库构建版本 */
  const browserPreview = !tauri

  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [versionFailed, setVersionFailed] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    getVersion()
      .then(v => { if (!cancelled) setCurrentVersion(`v${v}`) })
      .catch(err => {
        console.error('获取当前版本失败:', err)
        if (!cancelled) setVersionFailed(true)
      })
    return () => { cancelled = true }
  }, [])

  const displayVersion = currentVersion ?? (tauri ? null : FALLBACK_VERSION)
  const status = resolveUpdateStatus({
    tauri,
    checkStatus,
    state,
    version: info?.version ?? null,
    error,
  })
  const StatusIcon = status.icon
  const toneClass = TONE_TEXT_CLASS[status.tone]

  const handleCopyVersion = useCallback(async () => {
    if (!displayVersion) return
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(displayVersion)
      setCopied(true)
      addToast(`已复制版本号 ${displayVersion}`, 'success')
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      addToast('复制失败，请手动记录版本号。', 'error')
    }
  }, [displayVersion, addToast])

  // 「可更新版本」只在确实有更新时出现，没有更新时整行不渲染。
  const availableVersion = info?.version ?? null
  const hasUpdate = state === 'available' || state === 'downloading' || state === 'downloaded' || state === 'installing'
  const busy = isChecking || state === 'downloading' || state === 'installing'

  /**
   * 签名不匹配 / 本平台无产物时，再点「立即更新」必然同样失败：
   * 不给重试入口，改为引导用户去发布页手动下载（失败原因仍由状态区展示）。
   */
  const retryAllowed = canRetryUpdate(error)
  const showRetryEntry = state === 'available' && retryAllowed
  const showReleaseEntry = !!error && !retryAllowed

  const primaryBtn = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand-800 text-white hover:bg-brand-900 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2'
  const secondaryBtn = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2'

  return (
    <section
      aria-labelledby="update-section-title"
      data-testid="update-section"
      className="bg-white rounded-lg border border-gray-200 p-6"
    >
      <h2 id="update-section-title" className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <RefreshCw size={18} className="text-brand-600" aria-hidden="true" />
        版本更新
      </h2>

      <div className="space-y-3 text-sm">
        <dl className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
            <dt className="text-gray-500 shrink-0">当前版本</dt>
            <dd className="flex items-center gap-2 text-gray-900 font-medium min-w-0">
              <span data-testid="update-current-version" className="whitespace-nowrap tabular-nums">
                {displayVersion ?? '获取失败'}
              </span>
              {browserPreview && (
                <span
                  data-testid="update-version-source"
                  className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-600 whitespace-nowrap"
                >
                  构建版本
                </span>
              )}
              <button
                type="button"
                onClick={() => { void handleCopyVersion() }}
                disabled={!displayVersion}
                title="复制版本号"
                aria-label="复制版本号"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                {copied ? '已复制' : '复制'}
              </button>
            </dd>
          </div>

          {availableVersion && (
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
              <dt className="text-gray-500 shrink-0">可更新版本</dt>
              <dd
                data-testid="update-available-version"
                className="text-gray-900 font-medium whitespace-nowrap tabular-nums"
              >
                v{availableVersion}
              </dd>
            </div>
          )}

          {lastCheckedAt !== null && (
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
              <dt className="text-gray-500 shrink-0">上次检查</dt>
              <dd className="text-gray-900 font-medium whitespace-nowrap tabular-nums">
                {formatCheckedAt(lastCheckedAt)}
              </dd>
            </div>
          )}
        </dl>

        {browserPreview && (
          <p data-testid="update-version-note" className="text-xs text-gray-500">
            浏览器预览显示的是仓库构建版本，并非桌面端已安装的版本。
          </p>
        )}

        {versionFailed && (
          <p role="alert" className="text-xs text-red-700">获取当前版本失败，请重启应用后重试。</p>
        )}

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="update-status"
          className="flex items-start gap-2"
        >
          <StatusIcon
            size={16}
            className={`shrink-0 mt-0.5 ${toneClass} ${status.spinning ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span className={toneClass}>{status.text}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { void check() }}
            disabled={!tauri || busy}
            aria-busy={isChecking || undefined}
            className={hasUpdate ? secondaryBtn : primaryBtn}
          >
            {isChecking
              ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              : <RefreshCw size={14} aria-hidden="true" />}
            {isChecking ? '检查中…' : '检查更新'}
          </button>

          {showRetryEntry && (
            <button
              type="button"
              onClick={() => { void download() }}
              className={primaryBtn}
            >
              <Download size={14} aria-hidden="true" />
              立即更新
            </button>
          )}

          {/* 重试无意义时只给发布页入口，避免用户再点一次必然失败的更新 */}
          {showReleaseEntry && (
            <button
              type="button"
              onClick={() => { void openReleasePage() }}
              className={primaryBtn}
            >
              <ExternalLink size={14} aria-hidden="true" />
              打开发布页
            </button>
          )}

          {state === 'downloaded' && (
            <button
              type="button"
              onClick={() => { void install() }}
              className={primaryBtn}
            >
              <Download size={14} aria-hidden="true" />
              立即安装
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
