import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { MessageDTO, MessageDetailDTO, MessageFilter, PartDTO, SearchResult, IpcResult } from '../../shared/types'
import dbManager from '../database'

function parsePartData(row: Record<string, unknown>): PartDTO {
  let data: Record<string, unknown> = {}
  try {
    const rawData = row.data
    if (typeof rawData === 'string') {
      data = JSON.parse(rawData)
    } else if (typeof rawData === 'object' && rawData !== null) {
      data = rawData as Record<string, unknown>
    }
  } catch {
    /* keep data as empty object */
  }

  // Type is stored inside data JSON, not as a column
  const type = (data.type as PartDTO['type']) ?? 'text'
  const dataSize = typeof row.data === 'string' ? (row.data as string).length : 0

  const part: PartDTO = {
    id: row.id as string,
    message_id: row.message_id as string,
    session_id: row.session_id as string,
    type,
    data_size: dataSize,
  }

  // Parse type-specific fields
  switch (type) {
    case 'text': {
      const text = (data.text as string) ?? (data.content as string) ?? ''
      part.summary = text.length > 200 ? text.slice(0, 200) + '...' : text
      break
    }
    case 'tool': {
      part.toolName = (data.tool_name as string) ?? (data.toolName as string) ?? ''
      part.summary = part.toolName
      if (data.tool_input !== undefined || data.input !== undefined) {
        const input = data.tool_input ?? data.input
        part.input = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
      }
      if (data.tool_output !== undefined || data.output !== undefined) {
        const output = data.tool_output ?? data.output
        part.output = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
      }
      part.status = (data.status as string) ?? (data.result as string) ?? 'completed'
      break
    }
    case 'reasoning': {
      const text = (data.text as string) ?? ''
      part.summary = text.length > 200 ? text.slice(0, 200) + '...' : text
      break
    }
    case 'step-start': {
      const snapshot = data.snapshot as Record<string, unknown> | undefined
      part.summary = snapshot?.step_name as string ?? `Step ${snapshot?.step_id ?? ''}`
      break
    }
    case 'step-finish': {
      part.status = (data.result as string) ?? 'completed'
      part.summary = `Step finished: ${part.status}`
      if (data.tokens && typeof data.tokens === 'object') {
        const tokens = data.tokens as Record<string, unknown>
        part.tokens = {
          input: (tokens.input as number) ?? 0,
          output: (tokens.output as number) ?? 0,
          reasoning: (tokens.reasoning as number) ?? 0,
          cache_read: (tokens.cache_read as number) ?? 0,
          cache_write: (tokens.cache_write as number) ?? 0,
        }
      }
      break
    }
    case 'compaction':
    case 'patch':
    case 'file': {
      part.summary = `[${type}]`
      break
    }
  }

  return part
}

export function registerHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.MESSAGES_LIST,
    (_event, filter: MessageFilter): IpcResult<{ data: MessageDTO[]; total: number; page: number; pageSize: number }> => {
      try {
      const page = filter?.page ?? 1
      const pageSize = filter?.pageSize ?? 50
      const offset = (page - 1) * pageSize

      // Count total
      const countRow = dbManager.rawGet<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM message WHERE session_id = ?',
        [filter.sessionId]
      )
      const total = countRow?.cnt ?? 0

      // Query messages - role is in data JSON, not a column
      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT id, session_id, json_extract(data, '$.role') as role, LENGTH(data) as data_size, time_created
        FROM message
        WHERE session_id = ?
        ORDER BY time_created ASC
        LIMIT ? OFFSET ?`,
        [filter.sessionId, pageSize, offset]
      )

      const messages: MessageDTO[] = rows.map(row => ({
        id: row.id as string,
        session_id: row.session_id as string,
        role: (row.role as MessageDTO['role']) ?? 'user',
        data_size: (row.data_size as number) ?? 0,
        time_created: typeof row.time_created === 'string'
          ? new Date(row.time_created as string).getTime()
          : (row.time_created as number),
      }))

      return {
        success: true,
        data: {
          data: messages,
          total,
          page,
          pageSize,
        },
      }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MESSAGES_DETAIL,
    (_event, messageId: string): IpcResult<MessageDetailDTO | null> => {
      try {
      // Get message
      const row = dbManager.rawGet<Record<string, unknown>>(
        'SELECT * FROM message WHERE id = ?',
        [messageId]
      )

      if (!row) return { success: true, data: null }

      // Parse content from data field
      let content = ''
      let role: MessageDetailDTO['role'] = 'user'
      try {
        const data = typeof row.data === 'string' ? JSON.parse(row.data as string) : row.data
        if (typeof data === 'string') {
          content = data
        } else {
          // Extract role from data
          if (data?.role) {
            role = data.role as MessageDetailDTO['role']
          }
          if (data?.content) {
            content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2)
          } else {
            content = JSON.stringify(data, null, 2)
          }
        }
      } catch {
        content = (row.data as string) ?? ''
      }

      const message: MessageDetailDTO = {
        id: row.id as string,
        session_id: row.session_id as string,
        role,
        data_size: typeof row.data === 'string' ? (row.data as string).length : 0,
        time_created: typeof row.time_created === 'string'
          ? new Date(row.time_created as string).getTime()
          : (row.time_created as number),
        content,
        parts: [],
      }

      // Get parts
      const partRows = dbManager.rawQuery<Record<string, unknown>>(
        'SELECT * FROM part WHERE message_id = ? ORDER BY id ASC',
        [messageId]
      )

      message.parts = partRows.map(parsePartData)

      return { success: true, data: message }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MESSAGES_SEARCH,
    (_event, keyword: string): IpcResult<SearchResult[]> => {
      try {
        if (!keyword || !keyword.trim()) {
          return { success: true, data: [] }
        }

        const sql = `
          SELECT m.id, m.session_id,
                 json_extract(m.data, '$.content') as content,
                 s.title as session_title,
                 m.time_created
          FROM message m
          JOIN session s ON m.session_id = s.id
          WHERE json_extract(m.data, '$.content') LIKE ?
          ORDER BY m.time_created DESC
          LIMIT 100
        `
        const rows = dbManager.rawQuery<Record<string, unknown>>(sql, [`%${keyword}%`])

        const results: SearchResult[] = rows.map(row => ({
          id: row.id as string,
          session_id: row.session_id as string,
          content: (row.content as string) ?? '',
          session_title: (row.session_title as string) ?? '',
          time_created: typeof row.time_created === 'string'
            ? new Date(row.time_created as string).getTime()
            : (row.time_created as number),
        }))

        return { success: true, data: results }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
