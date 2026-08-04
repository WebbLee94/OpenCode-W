/**
 * Sidebar 单测 —— 验证 UpdateBadge 在 state='available' 时显示红点
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Sidebar } from './Sidebar'
import { UpdateContext } from '@/features/update/UpdateContext'
import { DataSourceContext } from '@/features/datasource/DataSourceContext'
import type { UseUpdateStatus } from '@/features/update/useUpdateStatus'

vi.mock('@/lib/ipc', () => ({
  isTauri: () => false,
}))

afterEach(() => {
  cleanup()
})

function renderWithContext(state: UseUpdateStatus['state']) {
  const mock: UseUpdateStatus = {
    state,
    info: null,
    progress: null,
    error: null,
    isChecking: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
  }
  return render(
    <UpdateContext.Provider value={mock}>
      <DataSourceContext.Provider value={{ connected: false, dbPath: '' }}>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </DataSourceContext.Provider>
    </UpdateContext.Provider>
  )
}

describe('Sidebar', () => {
  it('renders navigation labels', () => {
    renderWithContext('idle')
    expect(screen.getByText('仪表盘')).toBeTruthy()
    expect(screen.getByText('会话浏览')).toBeTruthy()
    expect(screen.getByRole('link', { name: '设置' })).toBeTruthy()
  })

  it('shows red dot when update is available', () => {
    renderWithContext('available')
    expect(screen.getByLabelText('有可用更新')).toBeTruthy()
  })

  it('hides red dot when idle', () => {
    renderWithContext('idle')
    expect(screen.queryByLabelText('有可用更新')).toBeNull()
  })

  it('hides red dot when downloading', () => {
    renderWithContext('downloading')
    expect(screen.queryByLabelText('有可用更新')).toBeNull()
  })

  it('shows red dot when downloaded', () => {
    renderWithContext('downloaded')
    expect(screen.getByLabelText('有可用更新')).toBeTruthy()
  })
})
