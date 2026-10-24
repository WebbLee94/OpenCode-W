/**
 * useDataSource hook
 * 订阅 DataSourceContext，暴露统一的数据源连接状态 API
 */
import { useContext } from 'react'
import { DataSourceContext, type DataSourceState } from './DataSourceContext'
import { deriveSchemaState, type DerivedSchemaState, type SchemaChangeInfo, type SchemaUiState } from './useSchemaInfo'

export function useDataSource() {
  const ctx = useContext(DataSourceContext)
  if (!ctx) {
    throw new Error('useDataSource 必须在 <DataSourceProvider> 内使用')
  }
  return ctx
}

/**
 * 宽松版数据源读取：没有 Provider 时返回空态而不抛错。
 *
 * 用于「降级占位」这类需要知道当前库路径、但也必须能在无 Provider 的
 * 测试 / 浏览器环境里正常渲染的组件。
 */
export function useOptionalDataSource(): DataSourceState {
  const ctx = useContext(DataSourceContext)
  return ctx ?? { connected: false, dbPath: '', dbSize: 0 }
}

/** 未挂 Provider 时的空态（浏览器 E2E / 单元测试）。 */
const EMPTY_SCHEMA: SchemaUiState = { kind: 'none' }

const noopAsync = async () => { /* no-op */ }
const noop = () => { /* no-op */ }
const noopReport = () => { /* no-op */ }

/**
 * 读取全局 schema 状态。
 *
 * 与 `useDataSource` 的区别：本 hook **不抛错**。没有 Provider 时退化为
 * 「未连接」空态，让仪表盘 / 会话 / 清理等页面在没有 Provider 的测试环境里
 * 保持原有行为（不进入降级态、不发起额外 IPC）。
 */
export function useSchemaStatus(): {
  state: SchemaUiState
  derived: DerivedSchemaState
  refreshing: boolean
  refreshError: string | null
  schemaChanged: SchemaChangeInfo | null
  refresh: () => Promise<void>
  clearSchemaChanged: () => void
  reportUnsupported: (path: string | null, reason: string | null) => void
} {
  const ctx = useContext(DataSourceContext)
  const state: SchemaUiState = ctx?.schema ?? EMPTY_SCHEMA
  return {
    state,
    derived: deriveSchemaState(state),
    refreshing: ctx?.schemaRefreshing ?? false,
    refreshError: ctx?.schemaRefreshError ?? null,
    schemaChanged: ctx?.schemaChanged ?? null,
    refresh: ctx?.refreshSchema ?? noopAsync,
    clearSchemaChanged: ctx?.clearSchemaChanged ?? noop,
    reportUnsupported: ctx?.reportUnsupported ?? noopReport,
  }
}
