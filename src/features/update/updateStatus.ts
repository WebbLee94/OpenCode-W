/**
 * 更新状态 → 用户可见文案 / 视觉语气的映射。
 *
 * 「设置 · 版本更新」区与「更新弹窗」共用这一份映射，
 * 保证同一状态在页面上只有一种说法（视觉文案与无障碍文案同源）。
 */
import type { LucideIcon } from 'lucide-react'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileQuestion,
  Info,
  Loader2,
  PackageCheck,
  PackageX,
  ShieldAlert,
  Sparkles,
  WifiOff,
} from 'lucide-react'
import type { UpdateCheckStatus, UpdateErrorPayload, UpdateState } from '@shared/types'
import { UPDATE_ERROR_COPY } from './errorClassifier'

export type UpdateStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface UpdateStatusView {
  /** 语义语气，决定文案与图标颜色 */
  tone: UpdateStatusTone
  /** 语义图标（装饰性，渲染时统一 aria-hidden） */
  icon: LucideIcon
  /** 完整句状态文案 */
  text: string
  /** 图标是否需要旋转（检查中 / 安装中） */
  spinning?: boolean
}

/** 语气 → 文字颜色。取值均满足正文对比度 ≥ 4.5:1（白底）。 */
export const TONE_TEXT_CLASS: Record<UpdateStatusTone, string> = {
  neutral: 'text-gray-600',
  info: 'text-brand-800',
  success: 'text-green-700',
  warning: 'text-amber-700',
  danger: 'text-red-700',
}

/** 各状态的固定文案 */
export const UPDATE_STATUS_COPY = {
  browserUnsupported: '浏览器预览环境不支持检查更新，请在桌面应用中查看版本信息。',
  idle: '尚未检查更新。',
  checking: '正在检查更新…',
  upToDate: '已是最新版本，无需更新。',
  available: (version: string) => `发现新版本 v${version}，可立即更新。`,
  downloading: (version: string) => `正在下载 v${version}…`,
  downloaded: (version: string) => `新版本 v${version} 已下载完成，重启后生效。`,
  installing: '正在安装并重启应用，请稍候。',
} as const

/** 错误码 → 语气 + 图标 */
const ERROR_TONE: Record<string, { tone: UpdateStatusTone; icon: LucideIcon }> = {
  network: { tone: 'danger', icon: WifiOff },
  ratelimit: { tone: 'warning', icon: AlertTriangle },
  'manifest-missing': { tone: 'warning', icon: FileQuestion },
  'no-platform-asset': { tone: 'warning', icon: PackageX },
  'signature-failed': { tone: 'danger', icon: ShieldAlert },
  'download-failed': { tone: 'danger', icon: Download },
  'install-failed': { tone: 'danger', icon: AlertCircle },
  unknown: { tone: 'danger', icon: AlertCircle },
}

/**
 * 依据「检查结果 + 下载流程 + 错误」推导当前应展示的状态。
 *
 * 优先级：
 *   1. 非 Tauri 环境 —— 无论如何都提示浏览器预览不支持
 *   2. 检查中
 *   3. 已产生的错误（下载 / 安装 / 检查失败）
 *   4. 下载流程状态
 *   5. 检查结论（已是最新 / 有更新 / 未检查）
 */
export function resolveUpdateStatus(params: {
  tauri: boolean
  checkStatus: UpdateCheckStatus
  state: UpdateState
  version: string | null
  error: UpdateErrorPayload | null
}): UpdateStatusView {
  const { tauri, checkStatus, state, version, error } = params

  if (!tauri) {
    return { tone: 'neutral', icon: Info, text: UPDATE_STATUS_COPY.browserUnsupported }
  }

  if (checkStatus === 'checking') {
    return { tone: 'info', icon: Loader2, text: UPDATE_STATUS_COPY.checking, spinning: true }
  }

  if (error) {
    const mapped = ERROR_TONE[error.code] ?? ERROR_TONE.unknown
    return { tone: mapped.tone, icon: mapped.icon, text: error.message }
  }

  const v = version ?? ''

  switch (state) {
    case 'downloading':
      return { tone: 'info', icon: Download, text: UPDATE_STATUS_COPY.downloading(v) }
    case 'downloaded':
      return { tone: 'info', icon: PackageCheck, text: UPDATE_STATUS_COPY.downloaded(v) }
    case 'installing':
      return { tone: 'info', icon: Loader2, text: UPDATE_STATUS_COPY.installing, spinning: true }
    case 'available':
      return { tone: 'info', icon: Sparkles, text: UPDATE_STATUS_COPY.available(v) }
    default:
      break
  }

  if (checkStatus === 'up-to-date') {
    return { tone: 'success', icon: CheckCircle2, text: UPDATE_STATUS_COPY.upToDate }
  }
  if (checkStatus === 'failed') {
    // 理论上失败一定有 error；兜底用 unknown 文案，绝不退化成「已是最新」。
    return { tone: 'danger', icon: AlertCircle, text: UPDATE_ERROR_COPY.unknown }
  }
  return { tone: 'neutral', icon: Info, text: UPDATE_STATUS_COPY.idle }
}

/**
 * 把时间戳格式化为本地时间，固定 `YYYY-MM-DD HH:mm`，
 * 避免不同 locale 下文案抖动，也方便测试断言。
 */
export function formatCheckedAt(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
