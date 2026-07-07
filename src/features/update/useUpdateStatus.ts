/**
 * useUpdateStatus hook
 * 订阅 UpdateContext,暴露统一的更新操作 API
 */
import { useContext } from 'react'
import { UpdateContext } from './UpdateContext'

export interface UseUpdateStatus {
  state: import('@shared/types').UpdateState
  info: import('@shared/types').UpdateInfo | null
  progress: import('@shared/types').UpdateProgress | null
  error: import('@shared/types').UpdateErrorPayload | null
  isChecking: boolean
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
}

export function useUpdateStatus(): UseUpdateStatus {
  const ctx = useContext(UpdateContext)
  if (!ctx) {
    throw new Error('useUpdateStatus 必须在 <UpdateProvider> 内使用')
  }
  return ctx
}
