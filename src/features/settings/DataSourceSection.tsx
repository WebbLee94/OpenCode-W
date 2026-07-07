/**
 * 设置页 - 数据源区块
 * 显示当前数据库连接状态 + 切换数据源按钮
 */
import { useState, useEffect, useCallback } from 'react'
import { invokeSafe, isElectron } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { Database, FolderSync, Loader2 } from 'lucide-react'

export function DataSourceSection() {
  const [dbConnected, setDbConnected] = useState(false)
  const [dbPath, setDbPath] = useState('')
  const [switching, setSwitching] = useState(false)

  const refreshStatus = useCallback(async () => {
    if (!isElectron()) {
      setDbConnected(false)
      setDbPath('')
      return
    }
    try {
      const health = await invokeSafe<{ ok: boolean; currentPath: string | null }>(IPC_CHANNELS.DATABASE_HEALTH)
      setDbConnected(health.ok)
      setDbPath(health.currentPath || '')
    } catch {
      setDbConnected(false)
      setDbPath('')
    }
  }, [])

  useEffect(() => { refreshStatus() }, [refreshStatus])

  const handleSwitch = async () => {
    try {
      setSwitching(true)
      const filePath = await invokeSafe<string>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      await invokeSafe<{ path: string }>(IPC_CHANNELS.DATABASE_OPEN, filePath)
      window.location.reload()
    } catch {
      // 用户取消选择，不做处理
    } finally {
      setSwitching(false)
    }
  }

  return (
    <section className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <Database size={18} className="text-brand-600" />
        数据源
      </h2>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dbConnected ? 'bg-green-500' : 'bg-gray-400'}`} />
          <span className="text-gray-500">状态：</span>
          <span className="text-gray-900 font-medium">{dbConnected ? '已连接' : '未连接'}</span>
        </div>
        {dbConnected && dbPath && (
          <div className="flex items-start gap-2">
            <span className="text-gray-500 shrink-0">数据库：</span>
            <span className="text-gray-700 font-mono text-xs break-all">{dbPath}</span>
          </div>
        )}
        <button
          onClick={handleSwitch}
          disabled={switching}
          className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
        >
          {switching ? <Loader2 size={14} className="animate-spin" /> : <FolderSync size={14} />}
          {switching ? '选择中...' : '切换数据源'}
        </button>
      </div>
    </section>
  )
}
