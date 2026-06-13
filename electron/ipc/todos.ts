import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { TodoDTO, TodoFilterByParent, IpcResult } from '../../shared/types'
import dbManager from '../database'

/**
 * Todos IPC — 仅服务于「会话详情」内嵌的待办 Tab
 * 独立「待办管理」页面已移除(2025-06)：用户可在任意会话详情内查看该会话及其子会话的待办
 * 因此不再需要全局 TODOS_LIST / TODOS_BY_SESSION
 */
export function registerHandlers(): void {
  // Todos by parent — merge parent + child sessions' todos
  // 修复「全部子会话」过滤只在前端列表过滤,实际后端只查父会话的 bug
  ipcMain.handle(
    IPC_CHANNELS.TODOS_BY_PARENT,
    (_event, filter: TodoFilterByParent): IpcResult<TodoDTO[]> => {
      try {
        const childIds = filter.childSessionIds ?? []
        // 去重,避免父子 ID 重复
        const allIds = Array.from(new Set([filter.parentSessionId, ...childIds]))
        if (allIds.length === 0) {
          return { success: true, data: [] }
        }

        // IN (?) 配合扩展参数
        const placeholders = allIds.map(() => '?').join(',')
        const rows = dbManager.rawQuery<TodoDTO>(
          `SELECT t.*, s.title as session_title
           FROM todo t
           JOIN session s ON t.session_id = s.id
           WHERE t.session_id IN (${placeholders})
           ORDER BY t.session_id ASC, t.position ASC`,
          allIds
        )

        return { success: true, data: rows }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
