import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { AccountDTO, AccountStateDTO, IpcResult, AccountUsageItem } from '../../shared/types'
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

  // ─── Route B: Account Usage Stats ────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.ACCOUNTS_USAGE, (): IpcResult<AccountUsageItem[]> => {
    try {
      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT a.id as accountId, a.email,
          COUNT(s.id) as sessionCount,
          COALESCE(SUM(s.tokens_input + s.tokens_output), 0) as tokenCount,
          COALESCE(SUM(s.cost), 0) as totalCost,
          CASE WHEN st.active_account_id = a.id THEN 1 ELSE 0 END as isActive
        FROM account a
        LEFT JOIN session s ON s.account_id = a.id
        LEFT JOIN account_state st ON 1=1
        GROUP BY a.id
        ORDER BY isActive DESC, sessionCount DESC`
      )
      return { success: true, data: rows.map(r => ({
        accountId: r.accountId as string, email: r.email as string,
        sessionCount: r.sessionCount as number, tokenCount: r.tokenCount as number,
        totalCost: r.totalCost as number, isActive: Boolean(r.isActive),
      })) }
    } catch (error) { return { success: false, error: (error as Error).message } }
  })
}
