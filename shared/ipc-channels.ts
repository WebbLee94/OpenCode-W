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
  DASHBOARD_PROJECTS: 'dashboard:projects',
  DASHBOARD_WORKSPACES: 'dashboard:workspaces',
  DASHBOARD_MODEL_RANKING: 'dashboard:modelRanking',
  DASHBOARD_PROVIDER_STATS: 'dashboard:providerStats',

  // Sessions
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_DETAIL: 'sessions:detail',
  SESSIONS_PROJECTS: 'sessions:projects',
  SESSIONS_DELETE: 'sessions:delete',
  SESSIONS_PARENT: 'sessions:parent',
  SESSIONS_CHILDREN: 'sessions:children',
  SESSIONS_RENAME: 'sessions:rename',

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
  DIALOG_SAVE_FILE: 'dialog:saveFile',

  // Backup
  BACKUP_CREATE: 'backup:create',
  BACKUP_LIST: 'backup:list',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_DELETE: 'backup:delete',
  BACKUP_PREVIEW: 'backup:preview',
  BACKUP_CONFIG_GET: 'backup:config:get',
  BACKUP_CONFIG_SET: 'backup:config:set',
  BACKUP_AUTO_CHECK: 'backup:auto-backup-check',

  // Todos
  TODOS_LIST: 'todos:list',
  TODOS_BY_SESSION: 'todos:bySession',

  // Session Share
  SESSION_SHARE_GET: 'session-share:get',
  SESSION_SHARES_LIST: 'session-shares:list',

  // Accounts
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_ACTIVE: 'accounts:active',
  ACCOUNTS_USAGE: 'accounts:usage',

  // Events
  EVENTS_LIST: 'events:list',
  EVENTS_DETAIL: 'events:detail',
} as const;

// Whitelist of channels allowed in renderer
export const ALLOWED_CHANNELS = Object.values(IPC_CHANNELS);
