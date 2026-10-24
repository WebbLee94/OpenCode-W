/**
 * 设置页 - 版本更新区
 *
 * 展示当前版本 + 可更新版本（仅在确实有更新时出现）+ 检查状态 + 检查更新按钮。
 *
 * 状态文案集中放在 `updateStatus.ts`，与更新弹窗共用同一份字符串，
 * 保证「页面上看到的」和「读屏软件读到的」完全一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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

/** 复制失败时的播报文案（toast 与读屏播报共用同一句，避免两处措辞漂移） */
const COPY_FAILED_MESSAGE = '复制失败，请手动记录版本号。'

/** 复制成功后的图标态与播报复位时间（毫秒） */
const COPY_FEEDBACK_MS = 2000

export function UpdateSection() {
  const { state, checkStatus, info, error, isChecking, lastCheckedAt, check, download, install } = useUpdateStatus()
  const { addToast } = useToast()
  const openReleasePage = useOpenReleasePage()
  const tauri = isTauri()
  /** 浏览器预览态：没有真实的桌面端版本号，只能显示仓库构建版本 */
  const browserPreview = !tauri

  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [versionFailed, setVersionFailed] = useState(false)
  /** 复制成功后图标切换为对勾 —— 状态用**形状**表达，不依赖颜色 */
  const [copied, setCopied] = useState(false)
  /** 复制结果的播报文案（喂给 sr-only 的 live region） */
  const [copyStatus, setCopyStatus] = useState('')
  /**
   * 播报序号：每次复制都自增，用作 live region 的 key。
   *
   * ⚠️ 为什么需要它：live region 复位后再次写入**同一句文案**时文本没有变化，
   * 多数读屏不会重播 —— 用户连点两次复制可能只听到一次。
   * 用递增 key 重建 live region 节点，读屏会把它当成一次全新的播报。
   */
  const [copySeq, setCopySeq] = useState(0)
  const copyResetTimer = useRef<number | null>(null)

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

  // 卸载时清掉复位计时器，避免对已卸载的组件回写状态
  useEffect(() => () => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
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

  /**
   * 安排复位：图标态与播报文案都在 2 秒后清空。
   * 连点时先清掉上一个计时器，否则先前的计时器会提前把第二次的反馈清掉。
   */
  const scheduleCopyReset = useCallback(() => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
    copyResetTimer.current = window.setTimeout(() => {
      copyResetTimer.current = null
      setCopied(false)
      setCopyStatus('')
    }, COPY_FEEDBACK_MS)
  }, [])

  const handleCopyVersion = useCallback(async () => {
    if (!displayVersion) return
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(displayVersion)
      setCopied(true)
      setCopyStatus(`已复制版本号 ${displayVersion}`)
      setCopySeq(seq => seq + 1)
      addToast(`已复制版本号 ${displayVersion}`, 'success')
    } catch {
      setCopyStatus(COPY_FAILED_MESSAGE)
      setCopySeq(seq => seq + 1)
      addToast(COPY_FAILED_MESSAGE, 'error')
    }
    scheduleCopyReset()
  }, [displayVersion, addToast, scheduleCopyReset])

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
              {/*
                复制按钮：**常驻但弱化**，靠颜色层级表达次要性，不用 opacity-0 / hidden
                控制显隐 —— 触屏没有 hover，藏起来等于按钮不存在；
                opacity-0 还会把焦点环一起藏掉（违反 WCAG 2.4.7）。
                命中区 28×28（size-7），保证触屏可用。
              */}
              <span className="relative group inline-flex shrink-0">
                <button
                  type="button"
                  onClick={() => { void handleCopyVersion() }}
                  disabled={!displayVersion}
                  aria-label="复制版本号"
                  className="inline-flex size-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                </button>
                {/*
                  自绘 tooltip 取代原生 title：原生 title 在键盘 focus 时不显示、
                  多数读屏也不暴露，两者并存还会弹出两个互相遮挡的提示。
                  group-focus-within 补上键盘路径（原生 title 补不了的那条）。
                  aria-hidden：按钮已有 aria-label，再用 aria-describedby 会让读屏念两遍。

                  ⚠️ 定位用 right-0（右对齐按钮）而不是居中：
                  居中会让 tooltip 往右探出卡片内容区，把「版本更新」区撑出横向滚动
                  （窄屏尤其明显）。右对齐只向左溢出，不产生横向滚动。
                */}
                <span
                  aria-hidden="true"
                  data-testid="copy-version-tooltip"
                  className="pointer-events-none absolute bottom-full right-0 z-50 mb-1 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  {copied ? '已复制' : '复制版本号'}
                </span>
              </span>
              {/*
                复制结果的读屏播报：aria-label 保持静态（否则控件列表里会出现两个同名条目，
                焦点按钮改名还会打断朗读），状态一律由这里播报。
                key={copySeq} 强制重建节点 → 连续复制同一句文案也会被重播。
              */}
              <span
                key={copySeq}
                role="status"
                aria-live="polite"
                aria-atomic="true"
                data-testid="copy-version-status"
                className="sr-only"
              >
                {copyStatus}
              </span>
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
