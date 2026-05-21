import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, 'test.db')

// Remove existing test database
if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH)
}
for (const ext of ['-wal', '-shm']) {
  if (existsSync(DB_PATH + ext)) unlinkSync(DB_PATH + ext)
}

mkdirSync(__dirname, { recursive: true })

const db = new Database(DB_PATH)

// Create tables matching actual OpenCode schema
// - message table has NO role column (role is in data JSON)
// - part table has NO type column (type is in data JSON)
db.exec(`
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    title TEXT,
    directory TEXT,
    model TEXT,
    agent TEXT,
    project_id TEXT,
    tokens_input INTEGER DEFAULT 0,
    tokens_output INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0,
    tokens_cache_write INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    data TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    data TEXT,
    time_created INTEGER,
    time_updated INTEGER,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id);
  CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id);
  CREATE INDEX IF NOT EXISTS idx_part_session ON part(session_id);
`)

// Generate realistic session data
const models = ['claude-sonnet-4-20250514', 'gpt-4o', 'claude-opus-4-20250514']
const projects = ['my-webapp', 'api-server', 'data-pipeline']
const directories = ['/Users/dev/my-webapp', '/Users/dev/api-server', '/Users/dev/data-pipeline']
const agents = ['coder', 'architect', 'debugger']
const sessionTitles = [
  'Fix authentication middleware bug',
  'Implement user dashboard feature',
  'Refactor database query optimization',
]

const sessions = []
const now = Date.now()

for (let i = 0; i < 3; i++) {
  const created = now - (3 - i) * 86400000
  const updated = now - (3 - i) * 86400000 + 3600000
  const tokensInput = 2000 + Math.floor(Math.random() * 8000)
  const tokensOutput = 1000 + Math.floor(Math.random() * 6000)
  const tokensReasoning = Math.floor(Math.random() * 4000)
  const tokensCacheRead = Math.floor(Math.random() * 2000)
  const tokensCacheWrite = Math.floor(Math.random() * 500)
  const cost = +(tokensInput * 0.000003 + tokensOutput * 0.000015 + tokensReasoning * 0.000005).toFixed(6)

  sessions.push({
    id: randomUUID(),
    title: sessionTitles[i],
    directory: directories[i],
    model: models[i],
    agent: agents[i],
    project_id: projects[i],
    tokens_input: tokensInput,
    tokens_output: tokensOutput,
    tokens_reasoning: tokensReasoning,
    tokens_cache_read: tokensCacheRead,
    tokens_cache_write: tokensCacheWrite,
    cost,
    time_created: created,
    time_updated: updated,
  })
}

// Insert sessions
const insertSession = db.prepare(`
  INSERT INTO session (id, title, directory, model, agent, project_id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost, time_created, time_updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

for (const s of sessions) {
  insertSession.run(
    s.id, s.title, s.directory, s.model, s.agent, s.project_id,
    s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
    s.cost, s.time_created, s.time_updated
  )
}

// Generate messages - role is inside data JSON
const roles: ('user' | 'assistant' | 'tool')[] = ['user', 'assistant', 'tool']
const messages: { id: string; session_id: string; data: string; time_created: number }[] = []

let msgTime = now - 3 * 86400000
for (let i = 0; i < 20; i++) {
  const sessionId = sessions[i % 3].id
  const role = roles[i % 3]
  msgTime += 30000 + Math.floor(Math.random() * 60000)

  let data: Record<string, unknown>
  if (role === 'user') {
    data = {
      role: 'user',
      time: { created: msgTime },
      summary: { diffs: [] },
      agent: agents[i % 3],
      model: { providerID: 'anthropic', modelID: models[i % 3] },
    }
  } else if (role === 'assistant') {
    data = {
      role: 'assistant',
      time: { created: msgTime },
      summary: { diffs: [] },
      agent: agents[i % 3],
      model: { providerID: 'anthropic', modelID: models[i % 3] },
    }
  } else {
    data = {
      role: 'tool',
      time: { created: msgTime },
      summary: { diffs: [] },
      agent: agents[i % 3],
      model: { providerID: 'anthropic', modelID: models[i % 3] },
    }
  }

  messages.push({
    id: randomUUID(),
    session_id: sessionId,
    data: JSON.stringify(data),
    time_created: msgTime,
  })
}

const insertMessage = db.prepare(`
  INSERT INTO message (id, session_id, data, time_created)
  VALUES (?, ?, ?, ?)
`)

for (const m of messages) {
  insertMessage.run(m.id, m.session_id, m.data, m.time_created)
}

// Generate parts - type is inside data JSON
const partTypes: ('text' | 'tool' | 'reasoning' | 'step-start' | 'step-finish')[] = ['text', 'tool', 'reasoning', 'step-start', 'step-finish']
const toolNames = ['read_file', 'write_file', 'bash', 'search', 'skill']
const skillNames = ['brainstorming', 'tdd', 'frontend', 'debugging', 'writing']

const parts: { id: string; session_id: string; message_id: string; data: string; time_created: number }[] = []

for (let i = 0; i < 80; i++) {
  const msg = messages[i % 20]
  const type = partTypes[i % 5]

  let data: Record<string, unknown>
  switch (type) {
    case 'text':
      data = { type: 'text', text: `This is text content for part ${i}. It contains some realistic output from the AI model discussing the implementation details of the authentication system.` }
      break
    case 'tool': {
      const toolIdx = i % 5
      const toolName = toolNames[toolIdx]
      if (toolName === 'skill') {
        data = {
          type: 'tool',
          tool_name: 'skill',
          skill_name: skillNames[i % 5],
          tool_input: { name: skillNames[i % 5], args: { task: `Task ${i}` } },
          tool_output: { result: `Skill ${skillNames[i % 5]} executed successfully` },
          status: 'completed'
        }
      } else {
        data = {
          type: 'tool',
          tool_name: toolName,
          tool_input: { path: `/src/module${i}.ts`, content: `// Module ${i} content` },
          tool_output: { result: `Output from ${toolName} for module ${i}` },
          status: i % 7 === 0 ? 'failed' : 'completed'
        }
      }
      break
    }
    case 'reasoning':
      data = { type: 'reasoning', text: `Let me think about this step by step. First, I need to understand the requirements, then analyze the existing code structure. The authentication middleware needs to properly validate JWT tokens before passing the request to the next handler.`, metadata: {}, time: {} }
      break
    case 'step-start':
      data = { type: 'step-start', snapshot: { step_id: `step-${i}`, step_name: `Step ${i}` } }
      break
    case 'step-finish':
      data = {
        type: 'step-finish',
        result: 'completed',
        tokens: {
          input: 100 + Math.floor(Math.random() * 500),
          output: 50 + Math.floor(Math.random() * 200),
          reasoning: Math.floor(Math.random() * 100),
          cache_read: Math.floor(Math.random() * 10000),
          cache_write: Math.floor(Math.random() * 1000),
        }
      }
      break
  }

  parts.push({
    id: randomUUID(),
    session_id: msg.session_id,
    message_id: msg.id,
    data: JSON.stringify(data),
    time_created: msg.time_created + i * 1000,
  })
}

const insertPart = db.prepare(`
  INSERT INTO part (id, session_id, message_id, data, time_created)
  VALUES (?, ?, ?, ?, ?)
`)

for (const p of parts) {
  insertPart.run(p.id, p.session_id, p.message_id, p.data, p.time_created)
}

// Verify data
const sessionCount = (db.prepare('SELECT COUNT(*) as count FROM session').get() as { count: number }).count
const messageCount = (db.prepare('SELECT COUNT(*) as count FROM message').get() as { count: number }).count
const partCount = (db.prepare('SELECT COUNT(*) as count FROM part').get() as { count: number }).count

db.close()

console.log(`Test database generated at: ${DB_PATH}`)
console.log(`   Sessions: ${sessionCount}`)
console.log(`   Messages: ${messageCount}`)
console.log(`   Parts:    ${partCount}`)
