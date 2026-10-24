/**
 * DataSourceContext —— 全局数据源连接状态
 * 统一管理 connected + dbPath，消除 Sidebar / DataSourceSection 各自独立 fetch 导致的闪烁
 *
 * 同时承载全局 schema 状态（规格 08.1 0.1）：侧边栏状态点与设置页徽标
 * 必须消费同一份 `SchemaUiState`，否则会出现「侧边栏红色、设置页蓝色」。
 */
import { createContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { invokeSafe, isTauri } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { HealthInfo } from '@shared/types'
import {
  useSchemaInfoController,
  type SchemaChangeInfo,
  type SchemaUiState,
} from './useSchemaInfo'

export interface DataSourceState {
  connected: boolean
  dbPath: string
  dbSize: number
  /**
   * 归一化后的 schema 状态。
   * 可选字段：未挂 `<DataSourceProvider>` 的测试 / 浏览器环境缺失时按空态处理，
   * 因此既有测试无需改动即可通过。
   */
  schema?: SchemaUiState
  /** 重新读取连接状态与库大小（清理后可让侧边栏立即反映变化） */
  refresh?: () => Promise<void>
  /** 「重新检测」进行中 */
  schemaRefreshing?: boolean
  /** 「重新检测」失败信息 */
  schemaRefreshError?: string | null
  /** 运行期检测到 schema 形态变化（需要重新打开数据库） */
  schemaChanged?: SchemaChangeInfo | null
  /** 「重新检测」：带 `refresh: true` 重新读取 schema */
  refreshSchema?: () => Promise<void>
  /** 清除 schema 形态变化提示 */
  clearSchemaChanged?: () => void
  /** 记录一次「打开失败且格式不受支持」 */
  reportUnsupported?: (path: string | null, reason: string | null) => void
}

export const DataSourceContext = createContext<DataSourceState | null>(null)

interface DataSourceProviderProps {
  children: ReactNode
}

export function DataSourceProvider({ children }: DataSourceProviderProps) {
  const [connected, setConnected] = useState(false)
  const [dbPath, setDbPath] = useState('')
  const [dbSize, setDbSize] = useState(0)
  const schemaController = useSchemaInfoController()

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
    <DataSourceContext.Provider
      value={{
        connected,
        dbPath,
        dbSize,
        refresh,
        schema: schemaController.state,
        schemaRefreshing: schemaController.refreshing,
        schemaRefreshError: schemaController.refreshError,
        schemaChanged: schemaController.schemaChanged,
        refreshSchema: schemaController.refresh,
        clearSchemaChanged: schemaController.clearSchemaChanged,
        reportUnsupported: schemaController.reportUnsupported,
      }}
    >
      {children}
    </DataSourceContext.Provider>
  )
}
