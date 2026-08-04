/**
 * useDataSource hook
 * 订阅 DataSourceContext，暴露统一的数据源连接状态 API
 */
import { useContext } from 'react'
import { DataSourceContext } from './DataSourceContext'

export function useDataSource() {
  const ctx = useContext(DataSourceContext)
  if (!ctx) {
    throw new Error('useDataSource 必须在 <DataSourceProvider> 内使用')
  }
  return ctx
}
