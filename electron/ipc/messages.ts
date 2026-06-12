import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { MessageDTO, MessageDetailDTO, MessageFilter, MessageListByParentFilter, PartDTO, PartType, PartTimeRange, PartFileSourceDTO, SearchResult, IpcResult } from '../../shared/types'
import dbManager from '../database'

/**
 * 两层兼容：canonical 字段优先，flat 字段兜底
 * OpenCode DB 同时存在 nested state（newer）和 flat（older）两种格式
 */
function pick<T = unknown>(data: Record<string, any>, ...paths: string[]): T | undefined {
  for (const p of paths) {
    const v = p.split('.').reduce((acc: any, k) => acc?.[k], data)
    if (v !== undefined && v !== null) return v as T
  }
  return undefined
}

function asString(v: unknown): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

function asStringOrUndef(v: unknown): string | undefined {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  return s || undefined
}

function parsePartData(row: Record<string, unknown>): PartDTO {
  let data: Record<string, any> = {}
  try {
    const rawData = row.data
    if (typeof rawData === 'string') data = JSON.parse(rawData)
    else if (typeof rawData === 'object' && rawData !== null) data = rawData as Record<string, any>
  } catch {
    /* keep data empty */
  }

  const type = (data.type as PartType) ?? 'text'
  const dataSize = typeof row.data === 'string' ? (row.data as string).length : 0

  const part: PartDTO = {
    id: row.id as string,
    message_id: row.message_id as string,
    session_id: row.session_id as string,
    type,
    data_size: dataSize,
  }

  if (data.metadata && typeof data.metadata === 'object') {
    part.metadata = data.metadata
  }

  switch (type) {
    // ============ TextPart ============
    case 'text': {
      const text = asString(pick(data, 'text', 'content'))
      part.text = text || undefined
      part.summary = text.length > 200 ? text.slice(0, 200) + '...' : text || undefined
      if (data.synthetic === true) part.synthetic = true
      if (data.ignored === true) part.ignored = true
      const time = pick<PartTimeRange>(data, 'time')
      if (time) part.time = time
      break
    }

    // ============ ReasoningPart ============
    case 'reasoning': {
      const text = asString(pick(data, 'text', 'content'))
      part.text = text || undefined
      part.summary = text.length > 200 ? text.slice(0, 200) + '...' : text || undefined
      const time = pick<PartTimeRange>(data, 'time')
      if (time) part.time = time
      break
    }

    // ============ ToolPart ============
    case 'tool': {
      // canonical: state nested; flat: tool_name/tool_input/tool_output/status
      // 工具名
      part.toolName = pick<string>(data, 'tool', 'tool_name') || ''
      // callID
      part.callID = pick<string>(data, 'callID') || undefined
      // 状态
      const status = pick<string>(data, 'state.status', 'status') || 'completed'
      if (['pending', 'running', 'completed', 'error'].includes(status)) {
        part.toolState = status as PartDTO['toolState']
      }
      part.status = status
      part.summary = part.toolName || '[tool]'

      // input
      const input = pick(data, 'state.input', 'tool_input', 'input')
      if (input !== undefined) part.input = asStringOrUndef(input)

      // output
      const output = pick(data, 'state.output', 'tool_output', 'output')
      if (output !== undefined) part.output = asStringOrUndef(output)

      // 错误
      const error = pick(data, 'state.error', 'error')
      if (error !== undefined) part.error = asStringOrUndef(error)

      // 标题
      const title = pick<string>(data, 'state.title', 'title')
      if (title) part.title = title

      // 附件
      const attachments = pick<unknown[]>(data, 'state.attachments')
      if (Array.isArray(attachments)) {
        part.attachments = attachments.map((a: any) => ({
          mime: a.mime,
          url: a.url,
          filename: a.filename,
        }))
      }

      // time
      const time = pick<PartTimeRange>(data, 'state.time', 'time')
      if (time) part.time = time

      break
    }

    // ============ FilePart ============
    case 'file': {
      part.fileMime = pick<string>(data, 'mime') || undefined
      part.fileName = pick<string>(data, 'filename') || undefined
      part.fileUrl = pick<string>(data, 'url') || undefined
      const source = pick(data, 'source')
      if (source && typeof source === 'object') {
        part.fileSource = source as PartFileSourceDTO
      }
      const filename = part.fileName || part.fileUrl || 'file'
      part.summary = `[file] ${part.fileMime || ''} ${filename}`.trim()
      break
    }

    // ============ PatchPart ============
    case 'patch': {
      part.patchHash = pick<string>(data, 'hash') || undefined
      part.patchFiles = pick<string[]>(data, 'files') || undefined
      part.summary = `[patch] ${part.patchFiles?.length ?? 0} 个文件`
      break
    }

    // ============ SnapshotPart ============
    case 'snapshot': {
      const snap = pick<string>(data, 'snapshot') || ''
      part.snapshotData = snap || undefined
      part.summary = snap ? `[snapshot] ${snap.slice(0, 30)}${snap.length > 30 ? '...' : ''}` : '[snapshot]'
      break
    }

    // ============ AgentPart ============
    case 'agent': {
      part.agentName = pick<string>(data, 'name') || undefined
      const source = pick<{ value: string; start: number; end: number }>(data, 'source')
      if (source && typeof source === 'object') {
        part.agentSource = source
      }
      part.summary = part.agentName ? `agent: ${part.agentName}` : '[agent]'
      break
    }

    // ============ StepStartPart ============
    case 'step-start': {
      // canonical: snapshot?: string; flat: snapshot: {step_id, step_name}
      const snap = pick<any>(data, 'snapshot')
      if (typeof snap === 'string') {
        part.stepSnapshot = snap
        part.summary = `[step] ${snap.slice(0, 30)}`
      } else if (snap && typeof snap === 'object') {
        const stepName = snap.step_name || `Step ${snap.step_id ?? ''}`
        part.summary = stepName
      } else {
        part.summary = 'Step start'
      }
      break
    }

    // ============ StepFinishPart ============
    case 'step-finish': {
      const reason = pick<string>(data, 'reason', 'result') || 'completed'
      part.reason = reason
      part.status = reason
      part.cost = pick<number>(data, 'cost')

      // tokens: canonical nested cache.{read,write} / flat cache_read+cache_write
      // 输出为 flat（与现有渲染端兼容，Commit 3 再迁嵌套）
      const tokens = pick<any>(data, 'tokens')
      if (tokens && typeof tokens === 'object') {
        const cacheNested = tokens.cache && typeof tokens.cache === 'object'
        part.tokens = {
          input: tokens.input ?? 0,
          output: tokens.output ?? 0,
          reasoning: tokens.reasoning ?? 0,
          cache_read: cacheNested ? (tokens.cache.read ?? 0) : (tokens.cache_read ?? 0),
          cache_write: cacheNested ? (tokens.cache.write ?? 0) : (tokens.cache_write ?? 0),
        }
        const t = part.tokens
        const summaryParts: string[] = []
        if (t.input) summaryParts.push(`in ${t.input}`)
        if (t.output) summaryParts.push(`out ${t.output}`)
        part.summary = `Step finished: ${reason} (${summaryParts.join('/')})`
      } else {
        part.summary = `Step finished: ${reason}`
      }
      break
    }

    // ============ SubtaskPart ============
    case 'subtask': {
      part.subtaskPrompt = pick<string>(data, 'prompt') || undefined
      part.subtaskDescription = pick<string>(data, 'description') || undefined
      part.subtaskAgent = pick<string>(data, 'agent') || undefined
      part.subtaskModel = pick(data, 'model') as { providerID: string; modelID: string } | undefined
      part.subtaskCommand = pick<string>(data, 'command') || undefined
      part.summary = part.subtaskDescription || part.subtaskPrompt?.slice(0, 40) || '[subtask]'
      break
    }

    // ============ RetryPart ============
    case 'retry': {
      part.retryAttempt = pick<number>(data, 'attempt')
      const errObj = pick<any>(data, 'error')
      part.retryError = asStringOrUndef(errObj)
      part.retryTime = pick<number>(data, 'time.created')
      part.summary = `Retry attempt ${part.retryAttempt ?? '?'}: ${part.retryError?.slice(0, 50) || 'unknown error'}`
      break
    }

    // ============ CompactionPart ============
    case 'compaction': {
      part.compactionAuto = pick<boolean>(data, 'auto')
      part.compactionOverflow = pick<boolean>(data, 'overflow')
      part.summary = part.compactionAuto === false ? '手动压缩' : (part.compactionOverflow ? '压缩（溢出）' : '自动压缩')
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
      // content_preview source: concatenated text parts (real content lives in part.data.text, not message.data)
      // 多 text part 用双换行连接（与 OpenCode toModelMessages 行为一致：所有 text part 都参与 message.parts）
      const rows = dbManager.rawQuery<Record<string, unknown>>(
        `SELECT id, session_id, json_extract(data, '$.role') as role, LENGTH(data) as data_size, time_created,
                COALESCE(
                  (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), char(10) || char(10))
                   FROM part p
                   WHERE p.message_id = message.id AND json_extract(p.data, '$.type') = 'text'
                   ORDER BY p.id ASC),
                  json_extract(data, '$.content'),
                  json_extract(data, '$.text'),
                  ''
                ) as content_preview
        FROM message
        WHERE session_id = ?
        ORDER BY time_created ASC
        LIMIT ? OFFSET ?`,
        [filter.sessionId, pageSize, offset]
      )

      const messages: MessageDTO[] = rows.map(row => {
        const rawContent = (row.content_preview as string) ?? ''
        return {
          id: row.id as string,
          session_id: row.session_id as string,
          role: (row.role as MessageDTO['role']) ?? 'user',
          data_size: (row.data_size as number) ?? 0,
          time_created: typeof row.time_created === 'string'
            ? new Date(row.time_created as string).getTime()
            : (row.time_created as number),
          content: rawContent || undefined,
        }
      })

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
    IPC_CHANNELS.MESSAGES_LIST_BY_PARENT,
    (_event, filter: MessageListByParentFilter): IpcResult<{ data: MessageDTO[]; total: number; page: number; pageSize: number }> => {
      try {
        const page = filter?.page ?? 1
        const pageSize = filter?.pageSize ?? 50
        const offset = (page - 1) * pageSize
        const sessionIds: string[] = []
        if (filter?.parentSessionId) sessionIds.push(filter.parentSessionId)
        if (filter?.childSessionIds) sessionIds.push(...filter.childSessionIds)
        if (sessionIds.length === 0) {
          return { success: true, data: { data: [], total: 0, page, pageSize } }
        }
        const placeholders = sessionIds.map(() => '?').join(',')

        const countRow = dbManager.rawGet<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM message WHERE session_id IN (${placeholders})`,
          sessionIds
        )
        const total = countRow?.cnt ?? 0

        const rows = dbManager.rawQuery<Record<string, unknown>>(
          `SELECT id, session_id, json_extract(data, '$.role') as role, LENGTH(data) as data_size, time_created,
                  COALESCE(
                    (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), char(10) || char(10))
                     FROM part p
                     WHERE p.message_id = message.id AND json_extract(p.data, '$.type') = 'text'
                     ORDER BY p.id ASC),
                    json_extract(data, '$.content'),
                    json_extract(data, '$.text'),
                    ''
                  ) as content_preview
           FROM message
           WHERE session_id IN (${placeholders})
           ORDER BY time_created ASC
           LIMIT ? OFFSET ?`,
          [...sessionIds, pageSize, offset]
        )

        const messages: MessageDTO[] = rows.map(row => {
          const rawContent = (row.content_preview as string) ?? ''
          return {
            id: row.id as string,
            session_id: row.session_id as string,
            role: (row.role as MessageDTO['role']) ?? 'user',
            data_size: (row.data_size as number) ?? 0,
            time_created: typeof row.time_created === 'string'
              ? new Date(row.time_created as string).getTime()
              : (row.time_created as number),
            content: rawContent || undefined,
          }
        })

        return { success: true, data: { data: messages, total, page, pageSize } }
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
