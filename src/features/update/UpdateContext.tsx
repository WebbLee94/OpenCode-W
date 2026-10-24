/**
 * UpdateContext —— 全局更新状态
 * 使用 @tauri-apps/plugin-updater 替代 Electron autoUpdater
 *
 * 状态分工：
 *   - checkStatus：这次「检查更新」得出了什么结论（未检查/检查中/已是最新/有更新/失败）
 *   - state：发现更新之后的下载安装流程（idle/available/downloading/downloaded/installing）
 *   - error：最近一次失败的分类结果（失败时**必须**写入，否则渲染不出错误态）
 */
import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater'
import { isTauri } from '@/lib/ipc'
import { useToast } from '@/hooks/useToast'
import { classifyUpdateError, UPDATE_ERROR_COPY } from './errorClassifier'
import { createDownloadProgressTracker } from './downloadProgress'
import { isValidTransition } from './stateMachine'
import type {
  UpdateCheckStatus,
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
  const [checkStatus, setCheckStatus] = useState<UpdateCheckStatus>('idle')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [error, setError] = useState<UpdateErrorPayload | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  /** 上次检查时间（毫秒时间戳）。仅内存态：Provider 全局存在，跨页面跳转自然保留。 */
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)
  /** 更新弹窗是否展开。与流程状态分离，用户可关闭弹窗但保留「有更新」结论。 */
  const [dialogOpen, setDialogOpen] = useState(false)
  const stateRef = useRef<UpdateState>('idle')
  /** 复用 check() 拿到的 Update 实例，避免下载时再发一次检查请求。 */
  const updateRef = useRef<Update | null>(null)
  /**
   * 「检查中」的**同步**守卫。
   *
   * `isChecking` 是 state，要等 React 重渲染后才变成 true，
   * 按钮的 `disabled={busy}` 同样要等重渲染才生效 ——
   * 双击会在重渲染前连发两次 check()。
   * 最坏组合：第一次拿到更新、第二次返回 null → 界面显示「已是最新」，
   * 而 updateRef 里仍留着更新实例。
   * ref 在任何 await 之前同步置位，因此同一时刻只可能有一次检查在途。
   */
  const checkingRef = useRef(false)
  const { addToast } = useToast()

  useEffect(() => { stateRef.current = state }, [state])

  const handleCheck = useCallback(async () => {
    if (!isTauri()) return
    // 同步守卫：isChecking 是 state，重渲染前仍是 false，双击会发出两次 check()。
    if (checkingRef.current) return
    checkingRef.current = true
    setIsChecking(true)
    setError(null)
    setCheckStatus('checking')
    // 重新检查时先清空旧结论，避免旧版本号与新状态文案打架。
    updateRef.current = null
    setInfo(null)
    stateRef.current = 'idle'
    setState('idle')
    setDialogOpen(false)
    try {
      const update = await checkUpdate()
      if (update) {
        updateRef.current = update
        stateRef.current = 'available'
        setState('available')
        setInfo({
          version: update.version,
          releaseDate: update.date ?? '',
          releaseNotes: update.body ?? '',
          sizeBytes: 0,
        })
        setCheckStatus('available')
        setLastCheckedAt(Date.now())
        setDialogOpen(true)
      } else {
        // check() 返回 null 表示**没有更新**（成功路径），不是错误。
        stateRef.current = 'idle'
        setState('idle')
        setInfo(null)
        setCheckStatus('up-to-date')
        setLastCheckedAt(Date.now())
      }
    } catch (err) {
      console.error('检查更新错误:', err)
      const classified = classifyUpdateError(err)
      // 失败必须落 error，否则 UI 渲染不出错误态。
      setError(classified)
      setCheckStatus('failed')
      stateRef.current = 'idle'
      setState('idle')
      setLastCheckedAt(Date.now())
    } finally {
      checkingRef.current = false
      setIsChecking(false)
    }
  }, [])

  const handleDownload = useCallback(async () => {
    if (!isTauri()) return
    if (!isValidTransition(stateRef.current, 'downloading')) return
    const update = updateRef.current
    if (!update) {
      // 没有可复用的 Update 实例（例如上下文被重置），提示重新检查。
      setError({ code: 'unknown', message: UPDATE_ERROR_COPY.unknown })
      return
    }
    stateRef.current = 'downloading'
    setState('downloading')
    setError(null)
    setDialogOpen(true)

    // 真实进度事件：Started 给总长度，Progress 给每个分片长度，Finished 收尾。
    const tracker = createDownloadProgressTracker()
    setProgress(tracker.snapshot())
    try {
      await update.downloadAndInstall((event) => {
        tracker.handleEvent(event)
        setProgress(tracker.snapshot())
      })
      setProgress(tracker.snapshot())
      stateRef.current = 'downloaded'
      setState('downloaded')
    } catch (err) {
      console.error('下载更新错误:', err)
      setError(classifyUpdateError(err))
      // 回到 available，用户可以重试下载。
      stateRef.current = 'available'
      setState('available')
    }
  }, [])

  const handleInstall = useCallback(async () => {
    if (!isTauri()) return
    if (!isValidTransition(stateRef.current, 'installing')) return
    stateRef.current = 'installing'
    setState('installing')
    setError(null)
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      console.error('重启应用失败:', err)
      // 重启失败不是「更新包」问题：给出独立提示并允许用户再次点击安装。
      addToast('重启失败，请手动启动应用。', 'error')
      stateRef.current = 'downloaded'
      setState('downloaded')
    }
  }, [addToast])

  const dismissDialog = useCallback(() => {
    // 下载 / 安装过程中不允许关闭弹窗。
    if (stateRef.current === 'downloading' || stateRef.current === 'installing') return
    setDialogOpen(false)
  }, [])

  const value = useMemo<UseUpdateStatus>(() => ({
    state,
    checkStatus,
    info,
    progress,
    error,
    isChecking,
    lastCheckedAt,
    dialogOpen,
    check: handleCheck,
    download: handleDownload,
    install: handleInstall,
    dismissDialog,
  }), [
    state, checkStatus, info, progress, error, isChecking, lastCheckedAt, dialogOpen,
    handleCheck, handleDownload, handleInstall, dismissDialog,
  ])

  return (
    <UpdateContext.Provider value={value}>
      {children}
    </UpdateContext.Provider>
  )
}
