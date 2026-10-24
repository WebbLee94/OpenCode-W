/**
 * 设置页 - 数据源区块
 * 显示当前数据库连接状态 + 路径脱敏 + 文件大小 + 打开所在目录 + 切换数据源按钮
 *
 *   - `unsupported` 时隐藏大小行
 *   - 「打开所在目录」常显（去掉 hover 才显示，窄屏 / 键盘下也可发现）
 */
import { useState, useEffect } from 'react'
import { homeDir } from '@tauri-apps/api/path'
import { invokeSafe, isTauri } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { useDataSource, useSchemaStatus } from '@/features/datasource/useDataSource'
import { isUnsupportedError } from '@/features/datasource/useSchemaInfo'
import { formatBytes, tildifyPath } from '@/lib/format'
import { Database, FolderOpen, FolderSync, Loader2 } from 'lucide-react'

export function DataSourceSection() {
  const { connected: dbConnected, dbPath, dbSize } = useDataSource()
  const {
    derived: schema,
    refresh,
    reportUnsupported,
  } = useSchemaStatus()
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState('')
  const [homePath, setHomePath] = useState('')

  useEffect(() => {
    if (!isTauri()) return
    homeDir()
      .then(setHomePath)
      .catch(() => setHomePath(''))
  }, [])

  // 窗口重新获得焦点时自动刷新一次 schema：用户可能在 OpenCode 里完成了迁移，
  // 切回来应当看到最新形态，而不是只能靠手动按钮。
  useEffect(() => {
    if (!isTauri()) return
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const handleSwitch = async () => {
    let filePath: string | null = null
    try {
      setSwitching(true)
      setSwitchError(null)
      // dialog_open_file 返回 Option<String>，用户取消时为 null
      filePath = await invokeSafe<string | null>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      if (!filePath) {
        // 用户取消了选择
        return
      }
      await invokeSafe<string>(IPC_CHANNELS.DATABASE_OPEN, filePath)
      window.location.reload()
    } catch (err) {
      console.error('切换数据源失败:', err)
      const message = (err as Error)?.message || '切换数据源失败'
      setSwitchError(message)
      // 格式不受支持时合成 unsupported 状态（规格 0.2 方案 B），
      // 让「无法识别的数据库格式」占位与「重新检测」可用。
      // 注意：已有可用连接时保持原状态（侧边栏不应误报红色）。
      if (isUnsupportedError(message) && !dbConnected) {
        reportUnsupported(filePath ?? null, message)
      }
    } finally {
      setSwitching(false)
    }
  }

  const handleReveal = async () => {
    try {
      setRevealing(true)
      setRevealError('')
      await invokeSafe<boolean>(IPC_CHANNELS.SHELL_REVEAL_DATABASE_DIRECTORY)
    } catch (err) {
      console.error('打开所在目录失败:', err)
      setRevealError('打开所在目录失败，请稍后重试。')
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
                title="打开数据库所在目录"
                aria-label="打开数据库所在目录"
                aria-busy={revealing || undefined}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-40 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
              >
                {revealing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              </button>
            </div>
            {revealError && <p role="alert" className="text-xs text-red-600">{revealError}</p>}
          </div>
        )}
        {/* unsupported 时大小不可靠，整行不渲染 */}
        {dbConnected && !schema.isSchemaBlocked && (
          <div className="flex items-center gap-2">
            <span className="text-gray-500 shrink-0">大小：</span>
            <span className="text-gray-700 font-medium">{formatBytes(dbSize)}</span>
          </div>
        )}
        {switchError && (
          <p role="alert" className="text-xs text-red-600 break-words">{switchError}</p>
        )}
        <button
          onClick={handleSwitch}
          disabled={switching}
          aria-busy={switching || undefined}
          className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed text-sm transition-colors"
        >
          {switching ? <Loader2 size={14} className="animate-spin" /> : <FolderSync size={14} />}
          {switching ? '选择中...' : '切换数据源'}
        </button>
      </div>
    </section>
  )
}
