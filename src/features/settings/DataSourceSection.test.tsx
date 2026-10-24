/**
 * DataSourceSection 单测：
 *   - 窗口重新获得焦点时自动刷新一次 schema
 *   - unsupported 时隐藏大小行
 *   - 「打开所在目录」常显（不再 hover 才出现）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataSourceSection } from './DataSourceSection'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import type { SchemaInfoDTO, SchemaUiState } from '@/features/datasource/useSchemaInfo'

const { invokeSafe, invalidateDashboardCache } = vi.hoisted(() => ({
  invokeSafe: vi.fn(),
  invalidateDashboardCache: vi.fn(),
}))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
}))

// 仪表盘模块只用到缓存失效函数，这里替换成可断言的 spy
vi.mock('@/features/dashboard/Dashboard', () => ({
  invalidateDashboardCache,
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: () => Promise.resolve('/Users/tester'),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  invokeSafe.mockReset()
  invokeSafe.mockResolvedValue(true)
  invalidateDashboardCache.mockReset()
})

function info(overrides: Partial<SchemaInfoDTO> = {}): SchemaInfoDTO {
  return {
    mode: 'v1',
    migrationPhase: 'none',
    hasLegacyTables: false,
    v2SessionCount: 0,
    unsupportedReason: null,
    ...overrides,
  }
}

function renderSection(overrides: Partial<DataSourceState> = {}, schema?: SchemaUiState) {
  const value: DataSourceState = {
    connected: true,
    dbPath: '/Users/tester/.local/share/opencode/opencode.db',
    dbSize: 2048,
    schema: schema ?? { kind: 'ready', info: info() },
    schemaRefreshing: false,
    schemaRefreshError: null,
    refreshSchema: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  return {
    value,
    ...render(
      <DataSourceContext.Provider value={value}>
        <DataSourceSection />
      </DataSourceContext.Provider>,
    ),
  }
}

describe('DataSourceSection', () => {
  it('窗口重新获得焦点时自动刷新 schema', () => {
    const { value } = renderSection()
    expect(value.refreshSchema).not.toHaveBeenCalled()
    fireEvent(window, new Event('focus'))
    expect(value.refreshSchema).toHaveBeenCalledTimes(1)
    fireEvent(window, new Event('focus'))
    expect(value.refreshSchema).toHaveBeenCalledTimes(2)
  })

  it('unsupported 时隐藏大小行', () => {
    renderSection({}, { kind: 'unsupported', reason: '缺少 session_message / session_v2 等表', path: null })
    expect(screen.queryByText('大小：')).toBeNull()
  })

  it('正常态显示大小行', () => {
    renderSection()
    expect(screen.getByText('大小：')).toBeTruthy()
  })

  it('「打开所在目录」常显，不再依赖 hover', () => {
    renderSection()
    const button = screen.getByRole('button', { name: '打开数据库所在目录' })
    expect(button.getAttribute('class') || '').not.toContain('opacity-0')
    expect(button.getAttribute('class') || '').not.toContain('group-hover')
  })

})
