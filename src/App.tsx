import { HashRouter, Routes, Route, NavLink, Outlet, useLocation } from 'react-router'
import logoSvg from '/brand/logo.svg'
import Dashboard from './features/dashboard/Dashboard'
import Sessions from './features/sessions/Sessions'
import Messages from './features/messages/Messages'
import Cleanup from './features/cleanup/Cleanup'
import Backup from './features/backup/Backup'
import { LayoutDashboard, MessageSquare, Trash2, HardDrive, ChevronRight, FolderSync } from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'
import { invoke, isElectron } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'

const navItems = [
  { to: '/', label: '首页仪表盘', icon: LayoutDashboard },
  { to: '/sessions', label: '会话浏览', icon: MessageSquare },
  { to: '/cleanup', label: '清理向导', icon: Trash2 },
  { to: '/backup', label: '备份恢复', icon: HardDrive },
]

function Breadcrumb() {
  const location = useLocation()
  const path = location.pathname

  const crumbs: { label: string; path?: string }[] = [{ label: '首页', path: '/' }]

  if (path.startsWith('/sessions')) {
    const match = path.match(/^\/sessions\/([^/]+)\/messages$/)
    if (match) {
      crumbs.push({ label: '会话浏览', path: '/sessions' })
      crumbs.push({ label: '消息查看器' })
    } else {
      crumbs.push({ label: '会话浏览' })
    }
  } else if (path.startsWith('/cleanup')) {
    crumbs.push({ label: '清理向导' })
  } else if (path.startsWith('/backup')) {
    crumbs.push({ label: '备份恢复' })
  }

  return (
    <div className="flex items-center gap-1.5 text-sm text-gray-500">
      {crumbs.map((crumb, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight size={14} />}
          {crumb.path ? (
            <NavLink to={crumb.path} className="hover:text-brand-600 transition-colors">
              {crumb.label}
            </NavLink>
          ) : (
            <span className="text-gray-900 font-medium">{crumb.label}</span>
          )}
        </span>
      ))}
    </div>
  )
}

function Layout() {
  const [dbConnected, setDbConnected] = useState(false)
  const [dbPath, setDbPath] = useState<string>('')

  const checkConnection = useCallback(async () => {
    if (!isElectron()) {
      setDbConnected(false)
      return
    }
    try {
      const health = await invoke<{ ok: boolean }>(IPC_CHANNELS.DATABASE_HEALTH)
      setDbConnected(health.ok)
    } catch {
      setDbConnected(false)
    }
  }, [])

  useEffect(() => {
    checkConnection()
  }, [checkConnection])

  const handleOpenDatabase = async () => {
    try {
      const filePath = await invoke<string | null>(IPC_CHANNELS.DIALOG_OPEN_FILE)
      if (filePath) {
        const result = await invoke<{ success: boolean }>(IPC_CHANNELS.DATABASE_OPEN, filePath)
        if (result.success) {
          setDbConnected(true)
          setDbPath(filePath)
          window.location.reload()
        }
      }
    } catch (err) {
      console.error('Failed to open database:', err)
    }
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <nav className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <img src={logoSvg} alt="DBScope-OC" className="w-6 h-6" />
            <div>
              <h1 className="text-base font-semibold text-gray-900">DBScope-OC</h1>
              <p className="text-xs text-gray-500">Database Manager</p>
            </div>
          </div>
        </div>
        <div className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-brand-50 text-brand-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </div>
        {/* Database connection status */}
        <div className="p-3 border-t border-gray-200">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 text-xs text-gray-700 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${dbConnected ? 'bg-green-500' : 'bg-gray-400'}`} />
              <span className="truncate">{dbConnected ? '已连接' : '未连接'}</span>
            </div>
            <button
              onClick={handleOpenDatabase}
              title="切换数据源"
              className="flex items-center justify-center w-8 h-8 rounded-md bg-gray-50 hover:bg-gray-100 transition-colors text-gray-500 hover:text-gray-700 shrink-0"
            >
              <FolderSync size={14} />
            </button>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 bg-white border-b border-gray-200 flex items-center px-4 shrink-0">
          <Breadcrumb />
          {dbPath && (
            <span className="ml-auto text-xs text-gray-400 truncate max-w-xs">{dbPath}</span>
          )}
        </header>
        {/* Content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:sessionId/messages" element={<Messages />} />
          <Route path="/cleanup" element={<Cleanup />} />
          <Route path="/backup" element={<Backup />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

export default App
