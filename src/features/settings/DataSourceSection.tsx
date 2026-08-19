/**
 * 设置页 - 数据源区块
 * 显示当前数据库连接状态 + 路径脱敏 + 文件大小 + 打开所在目录 + 切换数据源按钮
 */
import { useState, useEffect } from 'react'
import { homeDir } from '@tauri-apps/api/path'
import { invokeSafe, isTauri } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { useDataSource } from '@/features/datasource/useDataSource'
import { formatBytes, tildifyPath } from '@/lib/format'
import { Database, FolderOpen, FolderSync, Loader2 } from 'lucide-react'

export function DataSourceSection() {
  const { connected: dbConnected, dbPath, dbSize } = useDataSource()
  const [switching, setSwitching] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [homePath, setHomePath] = useState('')

  useEffect(() => {
    if (!isTauri()) return
    homeDir()
      .then(setHomePath)
      .catch(() => setHomePath(''))
  }, [])

  const handleSwitch = async () => {
    try {
      setSwitching(true)
      // dialog_open_file 返回 Option<String>，用户取消时为 null
      const filePath = await invokeSafe<string | null>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      if (!filePath) {
        // 用户取消了选择
        return
      }
      await invokeSafe<string>(IPC_CHANNELS.DATABASE_OPEN, filePath)
      window.location.reload()
    } catch (err) {
      console.error('切换数据源失败:', err)
    } finally {
      setSwitching(false)
    }
  }

  const handleReveal = async () => {
    try {
      setRevealing(true)
      await invokeSafe<boolean>(IPC_CHANNELS.SHELL_REVEAL_DATABASE_DIRECTORY)
    } catch (err) {
      console.error('打开所在目录失败:', err)
    } finally {
      setRevealing(false)
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
            <div className="flex-1 min-w-0 group flex items-center gap-2">
              <span className="text-gray-700 font-mono text-xs break-all">{tildifyPath(dbPath, homePath)}</span>
              <button
                onClick={handleReveal}
                disabled={revealing}
                title="打开所在目录"
                aria-label="打开所在目录"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-40 shrink-0"
              >
                {revealing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              </button>
            </div>
          </div>
        )}
        {dbConnected && (
          <div className="flex items-center gap-2">
            <span className="text-gray-500 shrink-0">大小：</span>
            <span className="text-gray-700 font-medium">{formatBytes(dbSize)}</span>
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
