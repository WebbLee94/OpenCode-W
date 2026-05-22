import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { EventDTO, IpcResult } from '../../shared/types'
import dbManager from '../database'

export function registerHandlers(): void {
  // Events list — optionally filter by aggregateId
  ipcMain.handle(
    IPC_CHANNELS.EVENTS_LIST,
    (_event, filter?: { aggregateId?: string }): IpcResult<EventDTO[]> => {
      try {
        if (filter?.aggregateId) {
          const rows = dbManager.rawQuery<EventDTO>(
            `SELECT e.* FROM event e
             WHERE e.aggregate_id = ?
             ORDER BY e.seq ASC
             LIMIT 200`,
            [filter.aggregateId]
          )
          return { success: true, data: rows }
        }

        const rows = dbManager.rawQuery<EventDTO>(
          `SELECT e.* FROM event e
           ORDER BY e.seq ASC
           LIMIT 200`
        )
        return { success: true, data: rows }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  // Events detail — single event with joined sequence info
  ipcMain.handle(
    IPC_CHANNELS.EVENTS_DETAIL,
    (_event, eventId: string): IpcResult<EventDTO & { es_seq: number; owner_id: string | null } | null> => {
      try {
        const row = dbManager.rawGet<EventDTO & { es_seq: number; owner_id: string | null }>(
          `SELECT e.*, es.seq as es_seq, es.owner_id
           FROM event e
           LEFT JOIN event_sequence es ON e.aggregate_id = es.aggregate_id
           WHERE e.id = ?`,
          [eventId]
        )

        return { success: true, data: row ?? null }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )
}
