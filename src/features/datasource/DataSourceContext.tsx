/**
 * DataSourceContext —— 全局数据源连接状态
 * 统一管理 connected + dbPath，消除 Sidebar / DataSourceSection 各自独立 fetch 导致的闪烁
 */
import { createContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { invokeSafe, isTauri } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'

export interface DataSourceState {
  connected: boolean
  dbPath: string
}

export const DataSourceContext = createContext<DataSourceState | null>(null)

interface DataSourceProviderProps {
  children: ReactNode
}

export function DataSourceProvider({ children }: DataSourceProviderProps) {
  const [connected, setConnected] = useState(false)
  const [dbPath, setDbPath] = useState('')

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setConnected(false)
      setDbPath('')
      return
    }
    try {
      const health = await invokeSafe<{ ok: boolean; currentPath: string | null }>(IPC_CHANNELS.DATABASE_HEALTH)
      setConnected(health.ok)
      setDbPath(health.currentPath || '')
    } catch {
      setConnected(false)
      setDbPath('')
    }
  }, [])

  useEffect(() => {
    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return (
    <DataSourceContext.Provider value={{ connected, dbPath }}>
      {children}
    </DataSourceContext.Provider>
  )
}
