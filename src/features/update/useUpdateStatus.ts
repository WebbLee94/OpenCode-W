/**
 * useUpdateStatus hook
 * 订阅 UpdateContext,暴露统一的更新操作 API
 */
import { useContext } from 'react'
import { UpdateContext } from './UpdateContext'
import type {
  UpdateCheckStatus,
  UpdateErrorPayload,
  UpdateInfo,
  UpdateProgress,
  UpdateState,
} from '@shared/types'

export interface UseUpdateStatus {
  /** 更新下载安装流程状态 */
  state: UpdateState
  /** 本次「检查更新」的结论：未检查 / 检查中 / 已是最新 / 有更新 / 失败 */
  checkStatus: UpdateCheckStatus
  /** 远端可更新版本信息（仅在确实有更新时存在） */
  info: UpdateInfo | null
  /** 下载进度（真实事件驱动） */
  progress: UpdateProgress | null
  /** 最近一次失败的分类结果 */
  error: UpdateErrorPayload | null
  /** 是否正在检查更新 */
  isChecking: boolean
  /** 上次检查完成的时间（毫秒时间戳，仅内存态，未检查时为 null） */
  lastCheckedAt: number | null
  /** 更新弹窗是否展开 */
  dialogOpen: boolean
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  /** 关闭更新弹窗（下载 / 安装过程中无效） */
  dismissDialog: () => void
}

export function useUpdateStatus(): UseUpdateStatus {
  const ctx = useContext(UpdateContext)
  if (!ctx) {
    throw new Error('useUpdateStatus 必须在 <UpdateProvider> 内使用')
  }
  return ctx
}
