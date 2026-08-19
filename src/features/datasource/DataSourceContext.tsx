/**
 * DataSourceContext —— 全局数据源连接状态
 * 统一管理 connected + dbPath，消除 Sidebar / DataSourceSection 各自独立 fetch 导致的闪烁
 */
import { createContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { invokeSafe, isTauri } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { HealthInfo } from '@shared/types'

export interface DataSourceState {
  connected: boolean
  dbPath: string
  dbSize: number
}

export const DataSourceContext = createContext<DataSourceState | null>(null)

interface DataSourceProviderProps {
  children: ReactNode
}

export function DataSourceProvider({ children }: DataSourceProviderProps) {
  const [connected, setConnected] = useState(false)
  const [dbPath, setDbPath] = useState('')
  const [dbSize, setDbSize] = useState(0)

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setConnected(false)
      setDbPath('')
      setDbSize(0)
      return
    }
    try {
      const health = await invokeSafe<HealthInfo>(IPC_CHANNELS.DATABASE_HEALTH)
      setConnected(health.ok)
      setDbPath(health.currentPath || '')
      setDbSize(health.dbSize ?? 0)
    } catch {
      setConnected(false)
      setDbPath('')
      setDbSize(0)
    }
  }, [])

  useEffect(() => {
    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return (
    <DataSourceContext.Provider value={{ connected, dbPath, dbSize }}>
      {children}
    </DataSourceContext.Provider>
  )
}
