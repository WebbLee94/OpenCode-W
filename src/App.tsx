import { HashRouter, Routes, Route, NavLink, Outlet, useLocation } from 'react-router'
import Dashboard from './features/dashboard/Dashboard'
import Sessions from './features/sessions/Sessions'
import Messages from './features/messages/Messages'
import Cleanup from './features/cleanup/Cleanup'
import Backup from './features/backup/Backup'
import Settings from './features/settings/Settings'
import { ChevronRight } from 'lucide-react'
import { ToastProvider } from './components/ToastProvider'
import { Sidebar } from './components/Sidebar'
import { UpdateProvider } from './features/update/UpdateContext'
import { UpdateDialog } from './features/update/UpdateDialog'

function Breadcrumb() {
  const location = useLocation()
  const path = location.pathname

  const crumbs: { label: string; path?: string }[] = [{ label: '首页', path: '/' }]

  if (path.startsWith('/sessions')) {
    const match = path.match(/^\/sessions\/([^/]+)\/messages$/)
    if (match) {
      crumbs.push({ label: '会话浏览', path: '/sessions' })
      crumbs.push({ label: '消息查看器' })
    } else if (path === '/sessions' || path.startsWith('/sessions?')) {
      const hash = window.location.hash
      const qp = new URLSearchParams(hash.includes('?') ? hash.split('?')[1] : '')
      if (qp.get('session')) {
        crumbs.push({ label: '会话浏览', path: '/sessions' })
        crumbs.push({ label: '会话详情' })
      } else {
        crumbs.push({ label: '会话浏览' })
      }
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
  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-12 bg-white border-b border-gray-200 flex items-center px-4 shrink-0">
          <Breadcrumb />
        </header>
        {/* Content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function App() {
  return (
    <ToastProvider>
      <UpdateProvider>
        <HashRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/sessions/:sessionId/messages" element={<Messages />} />
              <Route path="/cleanup" element={<Cleanup />} />
              <Route path="/backup" element={<Backup />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </HashRouter>
        <UpdateDialog />
      </UpdateProvider>
    </ToastProvider>
  )
}

export default App
