/**
 * UpdateContext —— 全局更新状态
 * 使用 @tauri-apps/plugin-updater 替代 Electron autoUpdater
 */
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { check as checkUpdate } from '@tauri-apps/plugin-updater'
import { isTauri } from '@/lib/ipc'
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

  useEffect(() => { stateRef.current = state }, [state])

  const handleCheck = useCallback(async () => {
    if (!isTauri()) return
    setIsChecking(true)
    setError(null)
    try {
      const update = await checkUpdate()
      if (update) {
        stateRef.current = 'available'
        setState('available')
        setInfo({
          version: update.version,
          releaseDate: update.date ?? '',
          releaseNotes: update.body ?? '',
          sizeBytes: 0,
        })
      } else {
        toast.addToast('当前已是最新版本', 'success')
      }
    } catch (err) {
      console.error('检查更新错误:', err)
      const classified = classifyUpdateError(err)
      if (classified.code === 'network') {
        toast.addToast(classified.message, 'error')
      } else {
        toast.addToast(classified.message, 'info')
      }
    } finally {
      setIsChecking(false)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    if (!isTauri()) return
    if (!isValidTransition(stateRef.current, 'downloading')) return
    stateRef.current = 'downloading'
    setState('downloading')
    setProgress({ bytesPerSecond: 0, percent: 0, transferred: 0, total: 0 })
    try {
      const update = await checkUpdate()
      if (update) {
        setProgress({ bytesPerSecond: 0, percent: 50, transferred: 0, total: 0 })
        await update.downloadAndInstall()
        setProgress({ bytesPerSecond: 0, percent: 100, transferred: 0, total: 0 })
        stateRef.current = 'downloaded'
        setState('downloaded')
      } else {
        throw new Error('更新已不可用，请重新检查')
      }
    } catch (err) {
      setError(classifyUpdateError(err))
      stateRef.current = 'available'
      setState('available')
    }
  }, [])

  const handleInstall = useCallback(async () => {
    if (!isTauri()) return
    if (!isValidTransition(stateRef.current, 'installing')) return
    stateRef.current = 'installing'
    setState('installing')
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch {
      toast.addToast('重启失败，请手动启动应用', 'error')
    }
  }, [])

  return (
    <UpdateContext.Provider value={{
      state, info, progress, error, isChecking,
      check: handleCheck,
      download: handleDownload,
      install: handleInstall,
    }}>
      {children}
    </UpdateContext.Provider>
  )
}
