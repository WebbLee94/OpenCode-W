import { useEffect, useState } from 'react'
import type { BackupDTO, BackupPreviewDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatNumber, formatRelativeTime } from '../../lib/format'
import { HardDrive, Archive, Trash2, RotateCcw, Download, Upload, AlertTriangle, Check, X, Clock } from 'lucide-react'

function Backup() {
  // Backup list
  const [backups, setBackups] = useState<BackupDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  // Create backup
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<BackupDTO | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  // Restore modal
  const [restoreModal, setRestoreModal] = useState<{ open: boolean; backup: BackupDTO | null; preview: BackupPreviewDTO | null; loading: boolean; restoring: boolean; success: boolean; error: string | null }>({
    open: false, backup: null, preview: null, loading: false, restoring: false, success: false, error: null,
  })

  // Delete confirmation modal
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; backup: BackupDTO | null; deleting: boolean; error: string | null }>({
    open: false, backup: null, deleting: false, error: null,
  })

  // Load backups on mount
  const loadBackups = async () => {
    setLoading(true)
    setListError(null)
    try {
      const list = await invokeSafe<BackupDTO[]>(IPC_CHANNELS.BACKUP_LIST)
      setBackups(list)
    } catch (err) {
      console.error('Failed to load backups:', err)
      setListError((err as Error).message || '加载备份列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBackups()
  }, [])

  // Create backup
  const handleCreateBackup = async () => {
    setCreating(true)
    setCreateResult(null)
    setCreateError(null)
    try {
      const result = await invokeSafe<BackupDTO>(IPC_CHANNELS.BACKUP_CREATE)
      setCreateResult(result)
      loadBackups()
    } catch (err) {
      setCreateError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  // Open restore modal
  const handleOpenRestore = async (backup: BackupDTO) => {
    setRestoreModal({ open: true, backup, preview: null, loading: true, restoring: false, success: false, error: null })
    try {
      const preview = await invokeSafe<BackupPreviewDTO>(IPC_CHANNELS.BACKUP_PREVIEW, backup.fileName)
      setRestoreModal(prev => ({ ...prev, preview, loading: false }))
    } catch (err) {
      setRestoreModal(prev => ({ ...prev, loading: false, error: (err as Error).message }))
    }
  }

  // Confirm restore
  const handleConfirmRestore = async () => {
    if (!restoreModal.backup) return
    setRestoreModal(prev => ({ ...prev, restoring: true }))
    try {
      await invokeSafe<{ path: string }>(IPC_CHANNELS.BACKUP_RESTORE, restoreModal.backup.filePath)
      setRestoreModal(prev => ({ ...prev, restoring: false, success: true }))
      loadBackups()
    } catch (err) {
      setRestoreModal(prev => ({ ...prev, restoring: false, error: (err as Error).message }))
    }
  }

  // Close restore modal
  const handleCloseRestoreModal = () => {
    setRestoreModal({ open: false, backup: null, preview: null, loading: false, restoring: false, success: false, error: null })
  }

  // Open delete modal
  const handleOpenDelete = (backup: BackupDTO) => {
    setDeleteModal({ open: true, backup, deleting: false, error: null })
  }

  // Confirm delete
  const handleConfirmDelete = async () => {
    if (!deleteModal.backup) return
    setDeleteModal(prev => ({ ...prev, deleting: true, error: null }))
    try {
      await invokeSafe(IPC_CHANNELS.BACKUP_DELETE, deleteModal.backup.fileName)
      setDeleteModal({ open: false, backup: null, deleting: false, error: null })
      loadBackups()
    } catch (err) {
      console.error('Failed to delete backup:', err)
      setDeleteModal(prev => ({ ...prev, deleting: false, error: (err as Error).message || '删除备份失败' }))
    }
  }

  // Close delete modal
  const handleCloseDeleteModal = () => {
    setDeleteModal({ open: false, backup: null, deleting: false, error: null })
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <h2 className="text-2xl font-semibold text-gray-900 mb-6">备份与恢复</h2>

      {/* ==================== Top Section: Backup Creation ==================== */}
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex items-center justify-center w-10 h-10 bg-brand-100 rounded-lg">
                <Download size={20} className="text-brand-600" />
              </div>
              <div>
                <h3 className="text-lg font-medium text-gray-900">创建备份</h3>
                <p className="text-sm text-gray-500">将当前数据库导出为备份文件</p>
              </div>
            </div>

            <div className="ml-13 space-y-2 text-sm">
              <div className="flex items-center gap-2 text-gray-600">
                <HardDrive size={14} className="text-gray-400" />
                <span>备份目录: ~/.DBScope-OC/backups/</span>
              </div>
            </div>
          </div>

          <button
            onClick={handleCreateBackup}
            disabled={creating}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {creating ? (
              <>
                <Archive size={16} className="animate-pulse" />
                备份中...
              </>
            ) : (
              <>
                <Download size={16} />
                立即备份
              </>
            )}
          </button>
        </div>

        {/* Create result */}
        {createResult && (
          <div className="mt-4 flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-sm">
            <Check size={16} className="text-green-600 shrink-0" />
            <span className="text-green-800">
              备份成功: {createResult.fileName} ({formatBytes(createResult.fileSize)})
            </span>
          </div>
        )}

        {createError && (
          <div className="mt-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm">
            <AlertTriangle size={16} className="text-red-600 shrink-0" />
            <span className="text-red-800">备份失败: {createError}</span>
          </div>
        )}
      </div>

      {/* ==================== Backup List ==================== */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">备份列表</h3>
          <button
            onClick={loadBackups}
            className="text-sm text-brand-600 hover:text-brand-800"
          >
            刷新
          </button>
        </div>

        {listError && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg mb-4 text-sm text-red-800">
            <AlertTriangle size={16} className="shrink-0" />
            {listError}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Archive size={24} className="animate-pulse mr-2" />
            加载中...
          </div>
        ) : backups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400">
            <Archive size={48} className="mb-3 opacity-50" />
            <p className="text-sm">暂无备份文件</p>
            <p className="text-xs mt-1">点击上方"立即备份"创建第一个备份</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden flex-1">
            <div className="overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">文件名</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 w-28">大小</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 w-44">创建时间</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-500 w-20">压缩</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 w-40">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map(backup => (
                    <tr key={backup.fileName} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-900">
                        <div className="flex items-center gap-2">
                          <Archive size={14} className="text-gray-400 shrink-0" />
                          <span className="truncate max-w-xs" title={backup.fileName}>{backup.fileName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">{formatBytes(backup.fileSize)}</td>
                      <td className="px-4 py-3 text-gray-600">
                        <div className="flex items-center gap-1.5">
                          <Clock size={12} className="text-gray-400" />
                          <span title={new Date(backup.createdAt).toLocaleString()}>
                            {formatRelativeTime(new Date(backup.createdAt).getTime())}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {backup.compressed ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-brand-100 text-brand-700">
                            gzip
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleOpenRestore(backup)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-green-700 bg-green-50 border border-green-200 rounded hover:bg-green-100 transition-colors"
                          >
                            <RotateCcw size={12} />
                            恢复
                          </button>
                          <button
                            onClick={() => handleOpenDelete(backup)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 transition-colors"
                          >
                            <Trash2 size={12} />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ==================== Restore Modal ==================== */}
      {restoreModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
            {restoreModal.success ? (
              // Success state
              <div className="p-6">
                <div className="text-center mb-4">
                  <div className="inline-flex items-center justify-center w-14 h-14 bg-green-100 rounded-full mb-3">
                    <Check size={28} className="text-green-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900">恢复成功</h3>
                  <p className="text-sm text-gray-500 mt-1">数据库已从备份恢复</p>
                </div>
                <div className="flex justify-center">
                  <button
                    onClick={handleCloseRestoreModal}
                    className="px-5 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors"
                  >
                    关闭
                  </button>
                </div>
              </div>
            ) : (
              // Normal restore dialog
              <>
                <div className="flex items-center justify-between p-5 border-b border-gray-200">
                  <h3 className="text-lg font-semibold text-gray-900">恢复备份</h3>
                  <button
                    onClick={handleCloseRestoreModal}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="p-5">
                  {/* Backup info */}
                  {restoreModal.backup && (
                    <div className="bg-gray-50 rounded-lg p-4 mb-4">
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-gray-500">文件名</span>
                          <span className="text-gray-900 font-medium truncate max-w-[240px]" title={restoreModal.backup.fileName}>
                            {restoreModal.backup.fileName}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">文件大小</span>
                          <span className="text-gray-900 font-medium">{formatBytes(restoreModal.backup.fileSize)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Content preview */}
                  {restoreModal.loading ? (
                    <div className="flex items-center justify-center py-6 text-gray-400">
                      <Archive size={20} className="animate-pulse mr-2" />
                      加载预览...
                    </div>
                  ) : restoreModal.preview ? (
                    <div className="bg-brand-50 rounded-lg p-4 mb-4">
                      <h4 className="text-sm font-medium text-brand-800 mb-2">备份内容</h4>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="text-center">
                          <div className="text-lg font-bold text-brand-700">{formatNumber(restoreModal.preview.sessionCount)}</div>
                          <div className="text-xs text-brand-600">会话</div>
                        </div>
                        <div className="text-center">
                          <div className="text-lg font-bold text-brand-700">{formatNumber(restoreModal.preview.messageCount)}</div>
                          <div className="text-xs text-brand-600">消息</div>
                        </div>
                        <div className="text-center">
                          <div className="text-lg font-bold text-brand-700">{formatNumber(restoreModal.preview.partCount)}</div>
                          <div className="text-xs text-brand-600">Part</div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {/* Warning */}
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4">
                    <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-sm text-amber-800">
                      恢复前将自动备份当前数据库，恢复后当前数据库将被替换
                    </div>
                  </div>

                  {/* Error */}
                  {restoreModal.error && (
                    <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg mb-4 text-sm text-red-800">
                      <AlertTriangle size={16} className="shrink-0" />
                      {restoreModal.error}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
                  <button
                    onClick={handleCloseRestoreModal}
                    disabled={restoreModal.restoring}
                    className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleConfirmRestore}
                    disabled={restoreModal.restoring || restoreModal.loading}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {restoreModal.restoring ? (
                      <>
                        <RotateCcw size={14} className="animate-spin" />
                        恢复中...
                      </>
                    ) : (
                      <>
                        <Upload size={14} />
                        确认恢复
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== Delete Confirmation Modal ==================== */}
      {deleteModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
            <div className="p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center justify-center w-10 h-10 bg-red-100 rounded-full">
                  <Trash2 size={20} className="text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">确认删除</h3>
                  <p className="text-sm text-gray-500">此操作不可撤销</p>
                </div>
              </div>

              {deleteModal.backup && (
                <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
                  <p className="text-gray-700">
                    确定要删除备份 <span className="font-medium text-gray-900">{deleteModal.backup.fileName}</span> 吗？
                  </p>
                  <p className="text-gray-500 mt-1">
                    文件大小: {formatBytes(deleteModal.backup.fileSize)}
                  </p>
                </div>
              )}

              {deleteModal.error && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg mb-4 text-sm text-red-800">
                  <AlertTriangle size={16} className="shrink-0" />
                  {deleteModal.error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={handleCloseDeleteModal}
                disabled={deleteModal.deleting}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleteModal.deleting}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleteModal.deleting ? (
                  <>
                    <Trash2 size={14} className="animate-pulse" />
                    删除中...
                  </>
                ) : (
                  <>
                    <Trash2 size={14} />
                    确认删除
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Backup
