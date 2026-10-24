/**
 * Schema 状态推导 —— 全应用唯一事实来源。
 *
 * 实现依据：`04-技术方案/08.1-Schema与迁移状态展示-设计规格.md`
 *   - 0.1 派生布尔值（`isReadOnly` 与后端 `DbState::is_read_only()` 逐字对齐）
 *   - 1.1 优先级表（**顺序本身就是设计决策，不得重排**）
 *   - 1.2 状态矩阵
 *
 * 设计约束：
 *   - 侧边栏状态点与设置页徽标必须消费同一个 `SchemaUiState`，
 *     否则会出现「侧边栏红色、设置页蓝色」。
 *   - 本模块不发起 IPC（除 `useSchemaInfoController`），纯函数部分可独立单测。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchSchemaInfo, isTauri } from '@/lib/ipc'
import type { MigrationPhase, SchemaInfoDTO, SchemaMode } from '@shared/types'

// 便于调用方一处导入 schema 相关类型
export type { MigrationPhase, SchemaInfoDTO, SchemaMode }

/**
 * 归一化后的 schema 状态。
 *
 * - `loading`：首次检测中（还没有任何信息）
 * - `none`：没有库，也没有失败记录
 * - `unsupported`：格式不受支持（**前端合成**的 fallback，见 `reportUnsupported`）
 * - `ready`：拿到 `SchemaInfoDTO`（v1 / v2 / v2-mixed / unsupported × 各 phase）
 *
 * `ready` 变体里的 `path` 是前端已知的库路径（例如用户选中但打不开的文件），
 * 后端 DTO 本身不带路径；`unsupported` DTO 也走 `ready` 分支，这样
 * 「running / failed 优先于 unsupported」的优先级表（规格 1.1 #3/#4）依然成立。
 */
export type SchemaUiState =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'unsupported'; reason: string | null; path: string | null }
  | { kind: 'ready'; info: SchemaInfoDTO; path?: string | null }

/** 派生状态 key —— 与规格 1.1 优先级表一一对应。 */
export type SchemaStateKey =
  | 'loading'
  | 'none'
  | 'running'
  | 'failed'
  | 'unsupported'
  | 'v2'
  | 'v1'

export interface DerivedSchemaState {
  key: SchemaStateKey
  mode: SchemaMode | null
  phase: MigrationPhase | null
  /** 无法识别格式的原因（`mode === 'unsupported'` 时来自后端） */
  reason: string | null
  /** 打开失败时用户选中的路径 */
  path: string | null
  /** `running || failed` —— 与后端 `DbState::is_read_only()` 对齐 */
  isReadOnly: boolean
  isMigrationRunning: boolean
  isMigrationFailed: boolean
  /** `unsupported` —— 四页受限占位 */
  isSchemaBlocked: boolean
}

/**
 * 状态推导（规格 1.1 优先级表）。
 *
 * 命中即返回，顺序不得重排：
 *   loading → none → running → failed → unsupported → mixed-legacy → v2 → v1
 */
export function deriveSchemaState(state: SchemaUiState): DerivedSchemaState {
  if (state.kind === 'loading') {
    return {
      key: 'loading',
      mode: null,
      phase: null,
      reason: null,
      path: null,
      isReadOnly: false,
      isMigrationRunning: false,
      isMigrationFailed: false,
      isSchemaBlocked: false,
    }
  }

  if (state.kind === 'none') {
    return {
      key: 'none',
      mode: null,
      phase: null,
      reason: null,
      path: null,
      isReadOnly: false,
      isMigrationRunning: false,
      isMigrationFailed: false,
      isSchemaBlocked: false,
    }
  }

  if (state.kind === 'unsupported') {
    return {
      key: 'unsupported',
      mode: 'unsupported',
      phase: null,
      reason: state.reason,
      path: state.path,
      isReadOnly: false,
      isMigrationRunning: false,
      isMigrationFailed: false,
      isSchemaBlocked: true,
    }
  }

  const info = state.info
  const isMigrationRunning = info.migrationPhase === 'running'
  const isMigrationFailed = info.migrationPhase === 'failed'

  let key: SchemaStateKey
  if (isMigrationRunning) {
    // 迁移中结构可能半成品，优先告诉用户「在迁移」而不是「格式错误」
    key = 'running'
  } else if (isMigrationFailed) {
    // 迁移失败比「格式无法识别」更可操作
    key = 'failed'
  } else if (info.mode === 'unsupported') {
    key = 'unsupported'
  } else if (info.mode === 'v2' || info.mode === 'v2-mixed') {
    // v2-mixed 与 v2 的数据面一致（v2-only 收口）：只操作 v2 表
    key = 'v2'
  } else {
    key = 'v1'
  }

  return {
    key,
    mode: info.mode,
    phase: info.migrationPhase,
    reason: info.unsupportedReason,
    path: state.path ?? null,
    isReadOnly: isMigrationRunning || isMigrationFailed,
    isMigrationRunning,
    isMigrationFailed,
    isSchemaBlocked: key === 'unsupported',
  }
}

/**
 * 判断后端错误是否代表「格式不受支持」。
 *
 * 后端 `db::open` 对 `SchemaMode::Unsupported` 返回
 * 「该文件不是受支持的 OpenCode 数据库（……）」，前端据此合成
 * `unsupported` 状态（规格 0.2 的方案 B）。
 */
export function isUnsupportedError(message: string | null | undefined): boolean {
  if (!message) return false
  return /不是受支持|受支持的\s*OpenCode|unsupported/i.test(message)
}

/**
 * 检测到的 schema 形态变化。
 *
 * 运行期 OpenCode 完成 v1→v2 迁移后，`database:info(refresh)` 会读到新的
 * mode，但**连接池仍按旧形态工作**（TEMP VIEW 按连接生效）：v1→v2-mixed
 * 会漏 v2-only 会话，v1→v2-fresh 可能报表缺失。因此必须提示用户重新打开
 * 数据库，让后端重建连接池。
 */
export interface SchemaChangeInfo {
  /** 变化前的 mode */
  from: SchemaMode
  /** 变化后的 mode */
  to: SchemaMode
}

export interface SchemaInfoController {
  state: SchemaUiState
  loading: boolean
  refreshing: boolean
  refreshError: string | null
  /** 检测到 mode 变化（需要重新打开数据库才能完整应用）；无变化为 null */
  schemaChanged: SchemaChangeInfo | null
  /** 「重新检测」：带 `refresh: true` 重新读取 schema */
  refresh: () => Promise<void>
  /** 记录一次「打开失败且格式不受支持」 */
  reportUnsupported: (path: string | null, reason: string | null) => void
  /** 清除 unsupported 合成状态 */
  clearUnsupported: () => void
  /** 清除 mode 变化提示（重新打开成功后调用） */
  clearSchemaChanged: () => void
}

/**
 * 持有 schema 状态并负责拉取。
 *
 * 只在 `DataSourceProvider` 上挂一次，避免侧边栏与设置页各自请求。
 * 不轮询：迁移期间不与 OpenCode 抢 SQLite 锁（规格 1.6）。
 */
export function useSchemaInfoController(): SchemaInfoController {
  const [state, setState] = useState<SchemaUiState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [schemaChanged, setSchemaChanged] = useState<SchemaChangeInfo | null>(null)
  // 用户选中但打不开的文件路径：后端 DTO 不带路径，unsupported 占位要显示它
  const attemptedPathRef = useRef<string | null>(null)
  // 上一次读到的 mode：用于比较新旧形态
  const lastModeRef = useRef<SchemaMode | null>(null)

  /**
   * 应用后端返回的 schema。
   *
   * 后端方案 A：`database:info` 在 pool 未打开时用 last_attempt_path 重探，
   * 直接返回 `mode: 'unsupported'` 的 DTO。**这份 DTO 优先于前端合成状态**，
   * 原因取后端的 `unsupportedReason`；但仍走 `ready` 分支，好让
   * 「running / failed 优先于 unsupported」的优先级表继续成立。
   *
   * 同时比较新旧 mode：变了就记下 `schemaChanged`，提示用户重新打开数据库
   * （连接池不会自动重建，需要显式重开才会重建）。
   */
  const applyInfo = useCallback((info: SchemaInfoDTO) => {
    // 比较新旧 mode：变了说明运行期发生了迁移，连接池仍是旧形态
    const prevMode = lastModeRef.current
    lastModeRef.current = info.mode
    if (prevMode !== null && prevMode !== info.mode) {
      setSchemaChanged({ from: prevMode, to: info.mode })
    }
    setState(prev => ({
      kind: 'ready',
      info,
      path:
        attemptedPathRef.current ??
        (prev.kind === 'unsupported' ? prev.path : null) ??
        (prev.kind === 'ready' ? prev.path : null),
    }))
  }, [])

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: 'none' })
      return
    }
    try {
      const info = await fetchSchemaInfo()
      applyInfo(info)
    } catch {
      // 没有已连接的数据库（或后端未缓存 schema）→ 空态；
      // 已经知道格式不受支持时保留该状态，等待用户重新检测。
      setState(prev => {
        if (prev.kind === 'unsupported') return prev
        if (prev.kind === 'ready' && prev.info.mode === 'unsupported') return prev
        return { kind: 'none' }
      })
    }
  }, [applyInfo])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    setRefreshing(true)
    setRefreshError(null)
    try {
      const info = await fetchSchemaInfo({ refresh: true })
      applyInfo(info)
    } catch (err) {
      setRefreshError((err as Error)?.message || '未知错误')
    } finally {
      setRefreshing(false)
    }
  }, [applyInfo])

  const reportUnsupported = useCallback((path: string | null, reason: string | null) => {
    attemptedPathRef.current = path
    setState({ kind: 'unsupported', reason, path })
  }, [])

  const clearUnsupported = useCallback(() => {
    setState(prev => (prev.kind === 'unsupported' ? { kind: 'none' } : prev))
  }, [])

  /** 清除 mode 变化提示：重新打开数据库成功后调用 */
  const clearSchemaChanged = useCallback(() => {
    setSchemaChanged(null)
  }, [])

  return {
    state,
    loading: state.kind === 'loading',
    refreshing,
    refreshError,
    schemaChanged,
    refresh,
    reportUnsupported,
    clearUnsupported,
    clearSchemaChanged,
  }
}
