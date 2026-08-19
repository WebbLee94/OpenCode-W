import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import { DataSourceContext, DataSourceProvider } from './DataSourceContext'
import { IPC_CHANNELS } from '@shared/ipc-channels'

const { invokeSafe } = vi.hoisted(() => ({ invokeSafe: vi.fn() }))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
}))

afterEach(() => {
  cleanup()
  invokeSafe.mockReset()
})

function ConnectionState() {
  const state = useContext(DataSourceContext)
  return <span>{state?.connected ? 'connected' : 'disconnected'}</span>
}

describe('DataSourceProvider', () => {
  it('uses only lightweight health during mount and focus refreshes', async () => {
    // Given: a connected database and an explicit diagnostic IPC channel.
    invokeSafe.mockResolvedValue({
      ok: true,
      currentPath: '/tmp/fixture.db',
      dbSize: 1,
    })

    // When: the provider mounts and the application window regains focus.
    render(
      <DataSourceProvider>
        <ConnectionState />
      </DataSourceProvider>,
    )
    await waitFor(() => expect(screen.getByText('connected')).toBeTruthy())
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(invokeSafe).toHaveBeenCalledTimes(2))

    // Then: both UI refreshes use the lightweight health command, never diagnostics.
    expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.DATABASE_HEALTH)
    expect(invokeSafe).not.toHaveBeenCalledWith(IPC_CHANNELS.DATABASE_INTEGRITY_CHECK)
  })
})
