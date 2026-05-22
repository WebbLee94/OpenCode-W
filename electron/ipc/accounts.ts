import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { AccountDTO, AccountStateDTO, IpcResult } from '../../shared/types'
import dbManager from '../database'

export function registerHandlers(): void {
  // Accounts list — all accounts (no sensitive tokens)
  ipcMain.handle(
    IPC_CHANNELS.ACCOUNTS_LIST,
    (): IpcResult<AccountDTO[]> => {
      try {
        const rows = dbManager.rawQuery<AccountDTO>(
          `SELECT id, email, url, token_expiry, time_created
           FROM account
           ORDER BY time_created DESC`
        )

        return { success: true, data: rows }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // Accounts active — current active account state
  ipcMain.handle(
    IPC_CHANNELS.ACCOUNTS_ACTIVE,
    (): IpcResult<AccountStateDTO | null> => {
      try {
        const row = dbManager.rawGet<AccountStateDTO>(
          `SELECT a.*, acc.email as account_email, acc.url as account_url
           FROM account_state a
           LEFT JOIN account acc ON a.active_account_id = acc.id
           LIMIT 1`
        )

        return { success: true, data: row ?? null }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
