import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Cleanup from './Cleanup'

const invokeSafeMock = vi.fn().mockResolvedValue([])

vi.mock('@/lib/ipc', () => ({
  invokeSafe: (...args: unknown[]) => invokeSafeMock(...args),
  isTauri: () => false,
}))

vi.mock('@/lib/format', () => ({
  formatBytes: (b: number) => `${b} B`,
  formatNumber: (n: number) => String(n),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderCleanup() {
  return render(
    <MemoryRouter initialEntries={['/cleanup']}>
      <Cleanup />
    </MemoryRouter>
  )
}

describe('Cleanup wizard', () => {
  it('renders three strategy options without custom', async () => {
    renderCleanup()
    await waitFor(() => {
      expect(screen.getByText('按时间')).toBeTruthy()
    })
    expect(screen.getByText('按大小')).toBeTruthy()
    expect(screen.getByText('按项目')).toBeTruthy()
    expect(screen.queryByText('自定义')).toBeNull()
  })

  it('renders no custom strategy description', async () => {
    renderCleanup()
    await waitFor(() => {
      expect(screen.getByText('按时间')).toBeTruthy()
    })
    expect(screen.queryByText('使用自定义 SQL WHERE 条件')).toBeNull()
  })

  it('shows sanitized project paths in select when projects are loaded', async () => {
    const mockProjects = [
      '/Users/webb/dev/OpenCode-W',
      '/Users/webb/dev/another-project',
      '/opt/homebrew/something',
      '/Volumes/external/project',
    ]
    invokeSafeMock.mockImplementation(async (channel: string) => {
      if (channel === 'sessions:projects') return mockProjects
      return []
    })

    renderCleanup()

    await waitFor(() => {
      expect(screen.getByDisplayValue('project')).toBeTruthy()
    })
    screen.getByDisplayValue('project').click()

    await waitFor(() => {
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select.options.length).toBeGreaterThan(1)
    })

    const select = screen.getByRole('combobox') as HTMLSelectElement
    const options = Array.from(select.options).map(o => o.textContent)

    expect(options).toContain('~/dev/OpenCode-W')
    expect(options).toContain('~/dev/another-project')
    expect(options).toContain('/opt/homebrew/something')
    expect(options).toContain('/Volumes/external/project')
    expect(options).not.toContain('/Users/webb/dev/OpenCode-W')
  })

  it('preserves full path as option value while showing sanitized label', async () => {
    const mockProjects = ['/Users/webb/dev/OpenCode-W']
    invokeSafeMock.mockImplementation(async (channel: string) => {
      if (channel === 'sessions:projects') return mockProjects
      return []
    })

    renderCleanup()

    await waitFor(() => {
      expect(screen.getByDisplayValue('project')).toBeTruthy()
    })
    screen.getByDisplayValue('project').click()

    await waitFor(() => {
      const select = screen.getByRole('combobox') as HTMLSelectElement
      expect(select.options.length).toBe(2)
    })

    const select = screen.getByRole('combobox') as HTMLSelectElement
    const option = select.options[1]

    expect(option.textContent).toBe('~/dev/OpenCode-W')
    expect(option.value).toBe('/Users/webb/dev/OpenCode-W')
  })
})
