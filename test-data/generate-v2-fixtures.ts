/**
 * OpenCode v2 数据库夹具生成脚本
 *
 * 生成两个 SQLite 夹具，用于验证 OpenCode-W 1.4.0 的 v1/v2 兼容层：
 *
 *   1. test-data/v2-fresh.db  仅 session_v2 + session_message + kv（+ project 维表），无旧表
 *   2. test-data/v2-mixed.db  v2 表与旧表并存，覆盖 legacy-only 会话 / 同 ID 消息去重 /
 *                             旧表尾消息补入（不丢尾数据）/ 全部 message.type 与 content.type
 *
 * Schema 与字段形状取自本机真实库 `~/.local/share/opencode/opencode.db`（OpenCode v2.1.2）
 * 的 sqlite_master 与真实数据行，未做主观简化。
 *
 * 运行：npm run generate-fixture:v2
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRESH_PATH = join(__dirname, 'v2-fresh.db')
const MIXED_PATH = join(__dirname, 'v2-mixed.db')

mkdirSync(__dirname, { recursive: true })

for (const path of [FRESH_PATH, MIXED_PATH]) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = path + suffix
    if (existsSync(target)) unlinkSync(target)
  }
}

// ---------------------------------------------------------------------------
// DDL —— 逐字取自真实库 sqlite_master（注释标出 v2 专属列）
// ---------------------------------------------------------------------------

const DDL_PROJECT = `
  CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,
    worktree TEXT NOT NULL,
    vcs TEXT,
    name TEXT,
    icon_url TEXT,
    icon_color TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_initialized INTEGER,
    sandboxes TEXT NOT NULL,
    commands TEXT,
    icon_url_override TEXT,
    time_active INTEGER DEFAULT 0 NOT NULL,
    time_archived INTEGER
  );
`

const DDL_SESSION_V2 = `
  CREATE TABLE IF NOT EXISTS session_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    fork_session_id TEXT,
    fork_boundary TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    path TEXT,
    title TEXT,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    metadata TEXT,
    cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    revert TEXT,
    permission TEXT,
    agent TEXT,
    model TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    time_suspended INTEGER,
    resume_attempts INTEGER DEFAULT 0 NOT NULL,
    time_idle INTEGER,
    time_viewed INTEGER,
    idle_outcome TEXT,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS session_v2_project_idx ON session_v2 (project_id);
  CREATE INDEX IF NOT EXISTS session_v2_parent_idx ON session_v2 (parent_id);
`

const DDL_SESSION_MESSAGE = `
  CREATE TABLE IF NOT EXISTS session_message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS session_message_session_seq_idx
    ON session_message (session_id, seq);
  CREATE INDEX IF NOT EXISTS session_message_session_type_seq_idx
    ON session_message (session_id, type, seq);
  CREATE INDEX IF NOT EXISTS session_message_session_time_created_id_idx
    ON session_message (session_id, time_created, id);
  CREATE INDEX IF NOT EXISTS session_message_time_created_idx
    ON session_message (time_created);
`

const DDL_KV = `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );
`

// 旧表（v1）：保留但冻结
const DDL_LEGACY = `
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    workspace_id TEXT,
    path TEXT,
    agent TEXT,
    model TEXT,
    cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    metadata TEXT,
    FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS message_session_time_created_id_idx
    ON message (session_id, time_created, id);
  CREATE INDEX IF NOT EXISTS idx_message_session_id ON message (session_id, time_created);

  CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS part_session_idx ON part (session_id);
  CREATE INDEX IF NOT EXISTS part_message_id_id_idx ON part (message_id, id);
  CREATE INDEX IF NOT EXISTS idx_part_session_id ON part (session_id, time_created);
`

// ---------------------------------------------------------------------------
// 确定性时间线与 ID（固定 ID 便于 sqlite3 断言）
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-10-01T00:00:00.000Z')
/** 距 T0 的分钟数 */
const at = (minutes: number) => T0 + minutes * 60_000

const PROJECT_ID = 'proj_fixture_v2'
const LEGACY_PROJECT_ID = 'proj_fixture_legacy'

const SESSION = {
  freshOnly1: 'ses_fresh_v2only_0001',
  freshOnly2: 'ses_fresh_v2only_0002',
  mixedOnly1: 'ses_mixed_v2only_0101',
  mixedOnly2: 'ses_mixed_v2only_0102',
  both1: 'ses_mixed_both_0201',
  both2: 'ses_mixed_both_0202',
  legacyOnly1: 'ses_mixed_legacy_0301',
} as const

const MODEL_PRIMARY = { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }
const MODEL_V2 = { providerID: 'opencode', id: 'gpt-5.6-terra', variant: 'default' }
const MODEL_V2_NEXT = { providerID: 'opencode', id: 'deepseek-v4.1-flash-free', variant: 'high' }

type Json = Record<string, unknown>

const j = (value: Json) => JSON.stringify(value)

// v2 内容块（E-07 只出现 text / reasoning / tool 三种）
const blockText = (text: string): Json => ({ type: 'text', text })
const blockReasoning = (text: string, created: number): Json => ({
  type: 'reasoning',
  text,
  time: { created, completed: created + 120 },
})
const blockToolCompleted = (id: string, name: string, input: Json, output: string, metadata?: Json): Json => ({
  type: 'tool',
  id,
  name,
  state: {
    status: 'completed',
    input,
    content: [{ type: 'text', text: output }],
    ...(metadata ? { metadata } : { time: { start: 0, end: 0 } }),
  },
})
const blockToolError = (id: string, name: string, input: Json, message: string): Json => ({
  type: 'tool',
  id,
  name,
  state: {
    status: 'error',
    input,
    error: { type: 'tool.execution', message },
  },
})

const tokens = (input: number, output: number, reasoning: number, read: number, write: number): Json => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

// ---------------------------------------------------------------------------
// v2 会话行
// ---------------------------------------------------------------------------

type SessionV2Row = {
  id: string
  title: string
  directory: string
  model: string
  agent: string
  createdAt: number
  updatedAt: number
  share_url: string | null
}

const sessionV2Rows: SessionV2Row[] = [
  {
    id: SESSION.freshOnly1,
    title: 'v2-fresh 会话 1：完整消息类型覆盖',
    directory: '/Users/dev/fixture-fresh-one',
    model: 'gpt-5.6-terra',
    agent: 'build',
    createdAt: at(0),
    updatedAt: at(60),
    share_url: null,
  },
  {
    id: SESSION.freshOnly2,
    title: 'v2-fresh 会话 2：compaction 与 agent 切换',
    directory: '/Users/dev/fixture-fresh-two',
    model: 'gpt-5.6-terra',
    agent: 'build',
    createdAt: at(120),
    updatedAt: at(180),
    share_url: 'https://opncd.ai/s/fixturefresh2',
  },
  {
    id: SESSION.mixedOnly1,
    title: 'v2-mixed 会话 1：仅存在于 session_v2',
    directory: '/Users/dev/fixture-mixed',
    model: 'claude-sonnet-4-6',
    agent: 'plan',
    createdAt: at(240),
    updatedAt: at(300),
    share_url: null,
  },
  {
    id: SESSION.mixedOnly2,
    title: 'v2-mixed 会话 2：仅存在于 session_v2（子会话）',
    directory: '/Users/dev/fixture-mixed',
    model: 'claude-sonnet-4-6',
    agent: 'build',
    createdAt: at(360),
    updatedAt: at(400),
    share_url: null,
  },
  {
    id: SESSION.both1,
    title: 'v2-mixed 会话 3：v2 与旧表都有（含同 ID 消息与旧表尾消息）',
    directory: '/Users/dev/fixture-migrated',
    model: 'claude-sonnet-4-6',
    agent: 'build',
    createdAt: at(480),
    updatedAt: at(560),
    share_url: null,
  },
  {
    id: SESSION.both2,
    title: 'v2-mixed 会话 4：v2 与旧表都有（含旧表尾消息）',
    directory: '/Users/dev/fixture-migrated',
    model: 'claude-sonnet-4-6',
    agent: 'build',
    createdAt: at(600),
    updatedAt: at(660),
    share_url: null,
  },
]

// ---------------------------------------------------------------------------
// session_message 行
// ---------------------------------------------------------------------------

type MessageV2Row = {
  id: string
  session_id: string
  type: 'assistant' | 'user' | 'system' | 'synthetic' | 'compaction' | 'idle' | 'model-switched' | 'agent-switched'
  seq: number
  time_created: number
  data: string
}

const sessionMessageRows: MessageV2Row[] = []

function addV2(
  sessionId: string,
  type: MessageV2Row['type'],
  seq: number,
  createdAt: number,
  data: Json
): void {
  sessionMessageRows.push({
    id: `${sessionId}_msg_${String(seq).padStart(2, '0')}`,
    session_id: sessionId,
    type,
    seq,
    time_created: createdAt,
    data: j(data),
  })
}

// --- v2-fresh 会话 1：覆盖 user / assistant / system / synthetic / idle / model-switched
addV2(SESSION.freshOnly1, 'system', 0, at(0), {
  text: 'The available tools have changed.\n\n`bash` is now `shell`; `task` is now `subagent`.',
  time: { created: at(0) },
})
addV2(SESSION.freshOnly1, 'user', 1, at(1), {
  text: '帮我梳理下这个仓库的数据读取链路',
  time: { created: at(1) },
})
addV2(SESSION.freshOnly1, 'assistant', 2, at(2), {
  agent: 'build',
  model: MODEL_V2,
  content: [
    blockReasoning('先确认 schema 与数据源入口。', at(2)),
    blockToolCompleted(
      'call_fresh_0001',
      'read',
      { filePath: '/Users/dev/fixture-fresh-one/src/db.rs', limit: 200 },
      'pub fn open(path: &Path) -> Result<Connection> { ... }',
      { truncated: false, bytes: 2048 }
    ),
    blockText('数据入口集中在 `src-tauri/src/db.rs`，兼容层将新增 `schema::detect`。'),
  ],
  finish: 'stop',
  tokens: tokens(56526, 84, 516, 0, 0),
  cost: 0.0174,
  time: { created: at(2), completed: at(3) },
})
addV2(SESSION.freshOnly1, 'synthetic', 3, at(4), {
  text: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
  time: { created: at(4) },
})
addV2(SESSION.freshOnly1, 'idle', 4, at(5), {
  time: { created: at(5) },
  outcome: 'failed',
  error: { type: 'provider.no-route', message: 'Model unavailable: opencode/gpt-5.4-mini' },
})
addV2(SESSION.freshOnly1, 'model-switched', 5, at(6), {
  time: { created: at(6) },
  model: MODEL_V2_NEXT,
  previous: MODEL_V2,
})

// --- v2-fresh 会话 2：compaction / agent-switched / 工具 error 分支
addV2(SESSION.freshOnly2, 'user', 0, at(120), {
  text: '继续上一轮任务，先压缩上下文',
  time: { created: at(120) },
})
addV2(SESSION.freshOnly2, 'assistant', 1, at(121), {
  agent: 'build',
  model: MODEL_V2,
  content: [
    blockToolError(
      'call_fresh_0101',
      'read',
      { filePath: '/tmp/does-not-exist.py' },
      'File not found: /tmp/does-not-exist.py'
    ),
    blockText('文件不存在，改为读取目录列表。'),
  ],
  finish: 'tool-calls',
  tokens: tokens(9348, 205, 256, 55808, 0),
  cost: 0.0042,
  time: { created: at(121), completed: at(122) },
})
addV2(SESSION.freshOnly2, 'compaction', 2, at(123), {
  status: 'completed',
  reason: 'auto',
  summary:
    '## Objective\n- 压缩前上下文：确认 v2 兼容层的数据读取路径。\n\n## Important Details\n- session_v2 / session_message 为权威数据源；旧表冻结残留。\n- token/cost 口径：逐消息汇总，不使用 session_v2 聚合列。',
  metadata: { tokens_before: 61234, tokens_after: 8123 },
  time: { created: at(123), completed: at(124) },
})
addV2(SESSION.freshOnly2, 'agent-switched', 3, at(125), {
  time: { created: at(125) },
  agent: 'oc-qa-engineer',
})

// --- v2-mixed：仅存在于 v2 的两个会话
addV2(SESSION.mixedOnly1, 'user', 0, at(240), { text: '只存在于 v2 的会话 1', time: { created: at(240) } })
addV2(SESSION.mixedOnly1, 'assistant', 1, at(241), {
  agent: 'plan',
  model: MODEL_V2,
  content: [blockText('该会话在旧表 `session` 中不存在，视图必须仍然返回它。')],
  finish: 'stop',
  tokens: tokens(1200, 300, 40, 0, 120),
  cost: 0.00091,
  time: { created: at(241), completed: at(242) },
})
addV2(SESSION.mixedOnly2, 'user', 0, at(360), { text: '只存在于 v2 的子会话', time: { created: at(360) } })
addV2(SESSION.mixedOnly2, 'assistant', 1, at(361), {
  agent: 'build',
  model: MODEL_V2,
  content: [blockText('父会话是 ses_mixed_v2only_0101。')],
  finish: 'stop',
  tokens: tokens(800, 120, 0, 0, 0),
  cost: 0.00035,
  time: { created: at(361), completed: at(362) },
})

// --- v2-mixed：v2 与旧表并存的会话（v2 为权威，旧表有同 ID 消息 + 尾消息）
addV2(SESSION.both1, 'user', 0, at(480), { text: '迁移前的第一条提问', time: { created: at(480) } })
addV2(SESSION.both1, 'assistant', 1, at(482), {
  agent: 'build',
  model: MODEL_V2,
  content: [blockText('迁移前的第一条回答。')],
  finish: 'stop',
  tokens: tokens(2000, 400, 100, 1000, 200),
  cost: 0.0018,
  time: { created: at(482), completed: at(483) },
})
addV2(SESSION.both1, 'user', 2, at(520), { text: '迁移后的提问（仅 v2）', time: { created: at(520) } })
addV2(SESSION.both1, 'assistant', 3, at(522), {
  agent: 'build',
  model: MODEL_V2,
  content: [
    blockReasoning('检查消息合并是否重复。', at(522)),
    blockToolCompleted(
      'call_mixed_0201',
      'shell',
      { command: 'sqlite3 v2-mixed.db "SELECT COUNT(*) FROM session_message"' },
      '17',
      { exitCode: 0 }
    ),
    blockText('该会话在 v2 的消息 id 与外层 message 表一致，必须只计一次。'),
  ],
  finish: 'stop',
  tokens: tokens(4500, 700, 320, 2200, 310),
  cost: 0.0061,
  time: { created: at(522), completed: at(523) },
})

addV2(SESSION.both2, 'user', 0, at(600), { text: '只有一条 v2 消息与旧表同 ID 的会话', time: { created: at(600) } })
addV2(SESSION.both2, 'assistant', 1, at(602), {
  agent: 'build',
  model: MODEL_V2,
  content: [blockText('这条 assistant 消息在旧表中有同 ID 副本。')],
  finish: 'stop',
  tokens: tokens(3300, 250, 60, 0, 0),
  cost: 0.0027,
  time: { created: at(602), completed: at(603) },
})

// ---------------------------------------------------------------------------
// 旧表数据（v1 形状）
// ---------------------------------------------------------------------------

type LegacySessionRow = {
  id: string
  project_id: string
  title: string
  directory: string
  model: string
  agent: string
  createdAt: number
  updatedAt: number
  tokensIn: number
  tokensOut: number
  cost: number
}

const legacySessions: LegacySessionRow[] = [
  // 与 v2 共存的两个会话（迁移残留）
  {
    id: SESSION.both1,
    project_id: LEGACY_PROJECT_ID,
    title: 'v2-mixed 会话 3（旧表副本）',
    directory: '/Users/dev/fixture-migrated',
    model: 'claude-sonnet-4-6',
    agent: 'build',
    createdAt: at(479),
    updatedAt: at(481),
    tokensIn: 2000,
    tokensOut: 400,
    cost: 0.0018,
  },
  {
    id: SESSION.both2,
    project_id: LEGACY_PROJECT_ID,
    title: 'v2-mixed 会话 4（旧表副本）',
    directory: '/Users/dev/fixture-migrated',
    model: 'claude-sonnet-4-6',
    agent: 'build',
    createdAt: at(599),
    updatedAt: at(601),
    tokensIn: 3300,
    tokensOut: 250,
    cost: 0.0027,
  },
  // 仅存在于旧表（legacy-only）
  {
    id: SESSION.legacyOnly1,
    project_id: LEGACY_PROJECT_ID,
    title: 'v2-mixed legacy-only 会话：只存在于旧表 session',
    directory: '/Users/dev/fixture-legacy',
    model: 'claude-sonnet-4-6',
    agent: 'build',
    createdAt: at(720),
    updatedAt: at(726),
    tokensIn: 900,
    tokensOut: 260,
    cost: 0.0007,
  },
]

type LegacyMessageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number
  role: 'user' | 'assistant'
  sharedWithV2: boolean
  tail: boolean
}

const legacyMessages: LegacyMessageRow[] = [
  // both1：2 条与 v2 同 ID（去重验证）
  {
    id: `${SESSION.both1}_msg_00`,
    session_id: SESSION.both1,
    time_created: at(480),
    time_updated: at(480),
    role: 'user',
    sharedWithV2: true,
    tail: false,
  },
  {
    id: `${SESSION.both1}_msg_01`,
    session_id: SESSION.both1,
    time_created: at(482),
    time_updated: at(483),
    role: 'assistant',
    sharedWithV2: true,
    tail: false,
  },
  // both1：1 条尾消息（time_created 晚于该会话 v2 最大时间 at(522)）
  {
    id: `${SESSION.both1}_msg_tail_00`,
    session_id: SESSION.both1,
    time_created: at(540),
    time_updated: at(541),
    role: 'assistant',
    sharedWithV2: false,
    tail: true,
  },
  // both2：1 条与 v2 同 ID + 1 条尾消息（晚于 at(602)）
  {
    id: `${SESSION.both2}_msg_01`,
    session_id: SESSION.both2,
    time_created: at(602),
    time_updated: at(603),
    role: 'assistant',
    sharedWithV2: true,
    tail: false,
  },
  {
    id: `${SESSION.both2}_msg_tail_00`,
    session_id: SESSION.both2,
    time_created: at(640),
    time_updated: at(641),
    role: 'user',
    sharedWithV2: false,
    tail: true,
  },
  // legacy-only 会话：2 条普通 v1 消息
  {
    id: `${SESSION.legacyOnly1}_msg_00`,
    session_id: SESSION.legacyOnly1,
    time_created: at(720),
    time_updated: at(720),
    role: 'user',
    sharedWithV2: false,
    tail: false,
  },
  {
    id: `${SESSION.legacyOnly1}_msg_01`,
    session_id: SESSION.legacyOnly1,
    time_created: at(726),
    time_updated: at(726),
    role: 'assistant',
    sharedWithV2: false,
    tail: false,
  },
]

function v1MessageData(role: 'user' | 'assistant', created: number): Json {
  return {
    role,
    time: { created },
    summary: { diffs: [] },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: MODEL_PRIMARY.modelID },
  }
}

type LegacyPartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: Json
}

const legacyParts: LegacyPartRow[] = []

for (const m of legacyMessages) {
  if (m.role === 'user') {
    legacyParts.push({
      id: `${m.id}_part_00`,
      message_id: m.id,
      session_id: m.session_id,
      time_created: m.time_created,
      time_updated: m.time_created,
      data: { type: 'text', text: m.tail ? '旧表尾消息（迁移后 v1 客户端追加写入）' : '旧表用户提问内容' },
    })
  } else {
    legacyParts.push({
      id: `${m.id}_part_00`,
      message_id: m.id,
      session_id: m.session_id,
      time_created: m.time_created,
      time_updated: m.time_created,
      data: { type: 'reasoning', text: '旧表 reasoning 分片', metadata: {}, time: {} },
    })
    legacyParts.push({
      id: `${m.id}_part_01`,
      message_id: m.id,
      session_id: m.session_id,
      time_created: m.time_created + 1,
      time_updated: m.time_created + 1,
      data: {
        type: 'text',
        text: m.tail ? '该消息只存在于旧表，v1 语义下必须出现在消息列表中。' : '旧表 assistant 文本内容',
      },
    })
  }
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

function insertProject(db: DatabaseSync, id: string, worktree: string, name: string): void {
  db.prepare(
    `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes, time_active)
     VALUES (?, ?, 'git', ?, ?, ?, '[]', 0)`
  ).run(id, worktree, name, T0, at(1000))
}

function writeSessions(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO session_v2
       (id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory, path,
        title, version, share_url, metadata, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        agent, model, time_created, time_updated, time_suspended, resume_attempts)
     VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?, NULL, ?, '1.4.0', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
  )
  for (const s of sessionV2Rows) {
    const parent = s.id === SESSION.mixedOnly2 ? SESSION.mixedOnly1 : null
    const tokenBase = s.id === SESSION.freshOnly1 ? [56526, 84, 516, 0, 0] : [1200, 300, 40, 0, 120]
    stmt.run(
      s.id,
      PROJECT_ID,
      parent,
      `fixture-${s.id.slice(-4)}`,
      s.directory,
      s.title,
      s.share_url,
      s.id === SESSION.freshOnly1 ? 0.0174 : 0.001,
      tokenBase[0],
      tokenBase[1],
      tokenBase[2],
      tokenBase[3],
      tokenBase[4],
      s.agent,
      s.model,
      s.createdAt,
      s.updatedAt
    )
  }
}

function writeSessionMessages(db: DatabaseSync): void {
  const stmt = db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const m of sessionMessageRows) {
    stmt.run(m.id, m.session_id, m.type, m.seq, m.time_created, m.time_created + 1, m.data)
  }
}

function writeKv(db: DatabaseSync): void {
  db.prepare(`INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)`).run(
    'migration.v1-v2',
    j({ phase: 'completed' }),
    T0,
    at(1000)
  )
  db.prepare(`INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)`).run(
    'fixture',
    j({ name: 'generate-v2-fixtures', schema: 'opencode-v2' }),
    T0,
    T0
  )
}

function writeLegacy(db: DatabaseSync): void {
  const sessionStmt = db.prepare(
    `INSERT INTO session
       (id, project_id, parent_id, slug, directory, title, version, share_url,
        time_created, time_updated, cost, tokens_input, tokens_output)
     VALUES (?, ?, NULL, ?, ?, ?, '1.3.0', NULL, ?, ?, ?, ?, ?)`
  )
  for (const s of legacySessions) {
    sessionStmt.run(
      s.id,
      s.project_id,
      `legacy-${s.id.slice(-4)}`,
      s.directory,
      s.title,
      s.createdAt,
      s.updatedAt,
      s.cost,
      s.tokensIn,
      s.tokensOut
    )
  }

  const messageStmt = db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`
  )
  for (const m of legacyMessages) {
    messageStmt.run(m.id, m.session_id, m.time_created, m.time_updated, j(v1MessageData(m.role, m.time_created)))
  }

  const partStmt = db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const p of legacyParts) {
    partStmt.run(p.id, p.message_id, p.session_id, p.time_created, p.time_updated, j(p.data))
  }
}

// --- v2-fresh.db ---
const fresh = new DatabaseSync(FRESH_PATH)
fresh.exec('PRAGMA foreign_keys = ON;')
fresh.exec(DDL_PROJECT)
fresh.exec(DDL_SESSION_V2)
fresh.exec(DDL_SESSION_MESSAGE)
fresh.exec(DDL_KV)
fresh.exec('BEGIN')
insertProject(fresh, PROJECT_ID, '/Users/dev/fixture-fresh-one', 'fixture-fresh')
writeSessions(fresh)
writeSessionMessages(fresh)
writeKv(fresh)
fresh.exec('COMMIT')
const freshFkViolations = fresh.prepare('PRAGMA foreign_key_check').all().length

// --- v2-mixed.db ---
const mixed = new DatabaseSync(MIXED_PATH)
mixed.exec('PRAGMA foreign_keys = ON;')
mixed.exec(DDL_PROJECT)
mixed.exec(DDL_SESSION_V2)
mixed.exec(DDL_SESSION_MESSAGE)
mixed.exec(DDL_KV)
mixed.exec(DDL_LEGACY)
mixed.exec('BEGIN')
insertProject(mixed, PROJECT_ID, '/Users/dev/fixture-mixed', 'fixture-mixed')
insertProject(mixed, LEGACY_PROJECT_ID, '/Users/dev/fixture-legacy', 'fixture-legacy')
writeSessions(mixed)
writeSessionMessages(mixed)
writeKv(mixed)
writeLegacy(mixed)
mixed.exec('COMMIT')
const mixedFkViolations = mixed.prepare('PRAGMA foreign_key_check').all().length

// ---------------------------------------------------------------------------
// 校验输出（写入后立即自检，避免夹具静默失真）
// ---------------------------------------------------------------------------

const count = (db: DatabaseSync, sql: string): number =>
  (db.prepare(sql).get() as { c: number }).c

const mixedChecks = {
  session_v2: count(mixed, 'SELECT COUNT(*) c FROM session_v2'),
  session_message: count(mixed, 'SELECT COUNT(*) c FROM session_message'),
  session_v2_only: count(
    mixed,
    'SELECT COUNT(*) c FROM session_v2 v WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = v.id)'
  ),
  session_legacy_only: count(
    mixed,
    'SELECT COUNT(*) c FROM session s WHERE NOT EXISTS (SELECT 1 FROM session_v2 v WHERE v.id = s.id)'
  ),
  mixed_session_view: count(
    mixed,
    `SELECT COUNT(*) c FROM (
       SELECT id FROM session_v2 UNION ALL SELECT id FROM session s
       WHERE NOT EXISTS (SELECT 1 FROM session_v2 v WHERE v.id = s.id)
     )`
  ),
  legacy_message: count(mixed, 'SELECT COUNT(*) c FROM message'),
  legacy_part: count(mixed, 'SELECT COUNT(*) c FROM part'),
  shared_message_ids: count(
    mixed,
    'SELECT COUNT(*) c FROM message m WHERE EXISTS (SELECT 1 FROM session_message sm WHERE sm.id = m.id)'
  ),
  legacy_tail_messages: count(
    mixed,
    `SELECT COUNT(*) c FROM message m
     WHERE m.time_created > (SELECT MAX(sm.time_created) FROM session_message sm WHERE sm.session_id = m.session_id)`
  ),
  types: mixed
    .prepare('SELECT type, COUNT(*) c FROM session_message GROUP BY type ORDER BY type')
    .all() as { type: string; c: number }[],
  content_types: mixed
    .prepare(
      `SELECT json_extract(c."value", '$.type') AS t, COUNT(*) c
       FROM session_message sm, json_each(sm.data, '$.content') c GROUP BY t ORDER BY t`
    )
    .all() as { t: string; c: number }[],
}

const legacyOnlyTailNote = `每个已迁移会话各 1 条尾消息：${mixedChecks.legacy_tail_messages} 条`

const freshChecks = {
  session_v2: count(fresh, 'SELECT COUNT(*) c FROM session_v2'),
  session_message: count(fresh, 'SELECT COUNT(*) c FROM session_message'),
  legacy_tables: (
    fresh
      .prepare(
        `SELECT COUNT(*) c FROM sqlite_master WHERE type='table'
         AND name IN ('session','message','part','todo','session_share')`
      )
      .get() as { c: number }
  ).c,
  migration_phase: (
    fresh.prepare(`SELECT json_extract(value, '$.phase') p FROM kv WHERE key = 'migration.v1-v2'`).get() as {
      p: string
    }
  ).p,
}

mixed.close()
fresh.close()

console.log('OpenCode v2 fixtures generated:')
console.log(`  v2-fresh.db: ${FRESH_PATH}`)
console.log(
  `    session_v2=${freshChecks.session_v2}  session_message=${freshChecks.session_message}  ` +
    `legacy_tables=${freshChecks.legacy_tables}  migration.phase=${freshChecks.migration_phase}  ` +
    `fk_violations=${freshFkViolations}`
)
console.log(`  v2-mixed.db: ${MIXED_PATH}`)
console.log(`    session_v2=${mixedChecks.session_v2}  session_message=${mixedChecks.session_message}`)
console.log(
  `    会话：v2-only=${mixedChecks.session_v2_only}  legacy-only=${mixedChecks.session_legacy_only}  ` +
    `视图合计=${mixedChecks.mixed_session_view}`
)
console.log(
  `    旧表：message=${mixedChecks.legacy_message}  part=${mixedChecks.legacy_part}  ` +
    `同 ID 消息=${mixedChecks.shared_message_ids}  尾消息=${mixedChecks.legacy_tail_messages}  ` +
    `fk_violations=${mixedFkViolations}`
)
console.log(`    session_message.type=${mixedChecks.types.map((t) => `${t.type}:${t.c}`).join(', ')}`)
console.log(
  `    content[].type=${mixedChecks.content_types.map((t) => `${t.t}:${t.c}`).join(', ')}`
)
console.log(`    ${legacyOnlyTailNote}`)
