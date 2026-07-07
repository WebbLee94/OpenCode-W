/**
 * UpdateContext —— 全局更新状态
 * 在 App 顶层挂载,自动订阅 IPC 事件
 */
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { isElectron } from '@/lib/ipc'
import { useToast } from '@/hooks/useToast'
import { classifyUpdateError } from './errorClassifier'
import { isValidTransition } from './stateMachine'
import type {
  UpdateState,
  UpdateInfo,
  UpdateProgress,
  UpdateErrorPayload,
} from '@shared/types'
import type { UseUpdateStatus } from './useUpdateStatus'

export const UpdateContext = createContext<UseUpdateStatus | null>(null)

interface UpdateProviderProps {
  children: ReactNode
}

export function UpdateProvider({ children }: UpdateProviderProps) {
  const [state, setState] = useState<UpdateState>('idle')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [error, setError] = useState<UpdateErrorPayload | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const stateRef = useRef<UpdateState>('idle')
  const toast = useToast()

  // 同步 ref 供事件回调内访问最新 state
  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.update) return

    const api = window.electronAPI.update
    const offAvail = api.onAvailable((payload) => {
      if (isValidTransition(stateRef.current, 'available')) {
        stateRef.current = 'available'
        setState('available')
        setInfo(payload)
        setError(null)
      }
    })
    const offProg = api.onProgress((p) => {
      setProgress(p)
    })
    const offDown = api.onDownloaded((payload) => {
      if (isValidTransition(stateRef.current, 'downloaded')) {
        stateRef.current = 'downloaded'
        setState('downloaded')
        setInfo(payload)
      }
    })
    const offErr = api.onError((err) => {
      setError(err)
      toast.addToast(`更新检查失败: ${err.message}`, 'error')
      // 错误不改变状态机:用户可重试
    })

    return () => {
      offAvail()
      offProg()
      offDown()
      offErr()
    }
  }, [])

  const check = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.update) return
    setIsChecking(true)
    try {
      const result = await window.electronAPI.update.check() as { success: boolean; data?: { skipped?: boolean } }
      if (result.data?.skipped) {
        // dev 模式:主进程直接返回 skipped=true,不会触发 update-available/not-available
        toast.addToast('开发模式已跳过检查，请使用打包后版本验证', 'info')
      } else if (!result.success) {
        setError(classifyUpdateError(new Error('check failed')))
        toast.addToast('检查更新失败', 'error')
      }
      // success && !skipped:等待 update-available 或 update-not-available 事件给出反馈
    } catch (err) {
      setError(classifyUpdateError(err))
      toast.addToast('检查更新失败', 'error')
    } finally {
      setIsChecking(false)
    }
  }, [])

  const download = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.update) return
    if (!isValidTransition(stateRef.current, 'downloading')) return
    stateRef.current = 'downloading'
    setState('downloading')
    setProgress(null)
    try {
      const result = await window.electronAPI.update.download() as { success: boolean; error?: string }
      if (!result.success) {
        setError(classifyUpdateError(new Error(result.error ?? 'download failed')))
        stateRef.current = 'available'
        setState('available')
      }
    } catch (err) {
      setError(classifyUpdateError(err))
      stateRef.current = 'available'
      setState('available')
    }
  }, [])

  const install = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.update) return
    if (!isValidTransition(stateRef.current, 'installing')) return
    stateRef.current = 'installing'
    setState('installing')
    await window.electronAPI.update.install()
  }, [])

  return (
    <UpdateContext.Provider value={{ state, info, progress, error, isChecking, check, download, install }}>
      {children}
    </UpdateContext.Provider>
  )
}
