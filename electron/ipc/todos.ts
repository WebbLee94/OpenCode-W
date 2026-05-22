import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { TodoDTO, TodoFilter, IpcResult } from '../../shared/types'
import dbManager from '../database'

export function registerHandlers(): void {
  // Todos list — global search with filters and pagination
  ipcMain.handle(
    IPC_CHANNELS.TODOS_LIST,
    (_event, filter?: TodoFilter): IpcResult<{ data: TodoDTO[]; total: number; page: number; pageSize: number }> => {
      try {
        const page = filter?.page ?? 1
        const pageSize = Math.min(filter?.pageSize ?? 20, 200)
        const offset = (page - 1) * pageSize

        const conditions: string[] = []
        const params: unknown[] = []

        if (filter?.search) {
          conditions.push('t.content LIKE ?')
          params.push(`%${filter.search}%`)
        }
        if (filter?.status) {
          conditions.push('t.status = ?')
          params.push(filter.status)
        }
        if (filter?.priority) {
          conditions.push('t.priority = ?')
          params.push(filter.priority)
        }
        if (filter?.projectId) {
          conditions.push('s.project_id = ?')
          params.push(filter.projectId)
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

        // Count total
        const countRow = dbManager.rawGet<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM todo t JOIN session s ON t.session_id = s.id ${whereClause}`,
          params
        )
        const total = countRow?.cnt ?? 0

        // Query with pagination
        const rows = dbManager.rawQuery<TodoDTO>(
          `SELECT t.*, s.title as session_title
           FROM todo t
           JOIN session s ON t.session_id = s.id
           ${whereClause}
           ORDER BY t.time_created DESC
           LIMIT ? OFFSET ?`,
          [...params, pageSize, offset]
        )

        return {
          success: true,
          data: { data: rows, total, page, pageSize },
        }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // Todos by session — single session's todos ordered by position
  ipcMain.handle(
    IPC_CHANNELS.TODOS_BY_SESSION,
    (_event, sessionId: string): IpcResult<TodoDTO[]> => {
      try {
        const rows = dbManager.rawQuery<TodoDTO>(
          `SELECT t.*, s.title as session_title
           FROM todo t
           JOIN session s ON t.session_id = s.id
           WHERE t.session_id = ?
           ORDER BY t.position ASC`,
          [sessionId]
        )

        return { success: true, data: rows }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
