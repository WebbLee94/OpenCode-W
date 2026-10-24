/**
 * Sidebar 状态点单测 —— 覆盖规格 08.1 第 4 节：
 *   - 正常态（v1 / v2 / 未连接）逐字保持原样，不加任何 role/aria
 *   - 仅 unsupported 替换圆点与文案并写 aria-label；running / failed 不再覆盖
 *
 * 单独成文件，避免改动既有 Sidebar.test.tsx。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Sidebar } from './Sidebar'
import { UpdateContext } from '@/features/update/UpdateContext'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import type { UseUpdateStatus } from '@/features/update/useUpdateStatus'
import type { SchemaInfoDTO, SchemaUiState } from '@/features/datasource/useSchemaInfo'

vi.mock('@/lib/ipc', () => ({
  isTauri: () => false,
}))

afterEach(() => {
  cleanup()
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

function renderSidebar(schema: SchemaUiState, connected = true) {
  const update: UseUpdateStatus = {
    state: 'idle',
    checkStatus: 'idle',
    info: null,
    progress: null,
    error: null,
    isChecking: false,
    lastCheckedAt: null,
    dialogOpen: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    dismissDialog: vi.fn(),
  }
  const dataSource: DataSourceState = { connected, dbPath: '', dbSize: 0, schema }
  return render(
    <UpdateContext.Provider value={update}>
      <DataSourceContext.Provider value={dataSource}>
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>
      </DataSourceContext.Provider>
    </UpdateContext.Provider>
  )
}

describe('Sidebar 状态点', () => {
  it('正常态：绿点 + 「已连接」，不加 role/aria', () => {
    const { container } = renderSidebar({ kind: 'ready', info: info({ mode: 'v1' }) })
    expect(screen.getByText('已连接')).toBeTruthy()
    const dot = container.querySelector('.bg-green-500')
    expect(dot).toBeTruthy()
    // 状态容器没有 live region 语义
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[aria-label]')).toBeNull()
  })

  it('未连接：灰点 + 「未连接」', () => {
    const { container } = renderSidebar({ kind: 'none' }, false)
    expect(screen.getByText('未连接')).toBeTruthy()
    expect(container.querySelector('.bg-gray-400')).toBeTruthy()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('running / failed：不覆盖状态点，正常显示「已连接」', () => {
    const { container } = renderSidebar({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) })
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(container.querySelector('.bg-green-500')).toBeTruthy()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('unsupported：红点 + 「数据库异常」+ aria-label', () => {
    const { container } = renderSidebar({ kind: 'unsupported', reason: '格式不支持', path: null })
    expect(screen.getByText('数据库异常')).toBeTruthy()
    expect(container.querySelector('.bg-red-500')).toBeTruthy()
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
      '数据库：无法识别的数据库格式',
    )
  })
})
