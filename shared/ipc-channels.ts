// IPC channel name constants shared between main and renderer processes

// Query channels (read-only)
export const IPC_CHANNELS = {
  // App info
  APP_GET_VERSION: 'app:getVersion',
  APP_GET_PLATFORM: 'app:getPlatform',

  // Dashboard
  DASHBOARD_OVERVIEW: 'dashboard:overview',
  DASHBOARD_TOKENS: 'dashboard:tokens',
  DASHBOARD_TOOL_RANKING: 'dashboard:toolRanking',
  DASHBOARD_SKILL_USAGE: 'dashboard:skillUsage',
  DASHBOARD_TRENDS: 'dashboard:trends',

  // Sessions
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_DETAIL: 'sessions:detail',
  SESSIONS_PROJECTS: 'sessions:projects',
  SESSIONS_DELETE: 'sessions:delete',

  // Messages
  MESSAGES_LIST: 'messages:list',
  MESSAGES_DETAIL: 'messages:detail',
  MESSAGES_SEARCH: 'messages:search',

  // Operations
  CLEANUP_PREVIEW: 'cleanup:preview',
  CLEANUP_EXECUTE: 'cleanup:execute',
  DATABASE_VACUUM: 'database:vacuum',
  DATABASE_CHECKPOINT: 'database:checkpoint',
  DATABASE_OPEN: 'database:open',
  DATABASE_HEALTH: 'database:health',

  // Dialog
  DIALOG_OPEN_FILE: 'dialog:openFile',

  // Backup
  BACKUP_CREATE: 'backup:create',
  BACKUP_LIST: 'backup:list',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_DELETE: 'backup:delete',
  BACKUP_PREVIEW: 'backup:preview',

  // Todos
  TODOS_LIST: 'todos:list',
  TODOS_BY_SESSION: 'todos:bySession',

  // Session Share
  SESSION_SHARE_GET: 'session-share:get',

  // Accounts
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_ACTIVE: 'accounts:active',

  // Events
  EVENTS_LIST: 'events:list',
  EVENTS_DETAIL: 'events:detail',
} as const;

// Whitelist of channels allowed in renderer
export const ALLOWED_CHANNELS = Object.values(IPC_CHANNELS);
