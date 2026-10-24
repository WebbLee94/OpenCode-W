import Modal from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  loading?: boolean;
  /**
   * 禁用确认按钮（用于迁移中 / 迁移失败的只读闸门）。
   * 即使弹窗已经打开，也能在状态变化后立刻拦住写操作。
   */
  disabled?: boolean;
}

const confirmStyles: Record<string, string> = {
  danger: 'bg-red-600 hover:bg-red-700',
  warning: 'bg-yellow-600 hover:bg-yellow-700',
  default: 'bg-blue-600 hover:bg-blue-700',
};

export default function ConfirmDialog({
  isOpen, onClose, onConfirm, title, message,
  confirmLabel = '确认', variant = 'default', loading = false, disabled = false,
}: ConfirmDialogProps) {
  const confirmDisabled = loading || disabled
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <p className="text-gray-600 mb-6">{message}</p>
      <div className="flex justify-end gap-3">
        <button onClick={onClose} disabled={loading}
          className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50">
          取消
        </button>
        <button onClick={onConfirm} disabled={confirmDisabled} aria-disabled={disabled || undefined}
          className={`px-4 py-2 text-sm text-white rounded disabled:opacity-50 disabled:cursor-not-allowed ${confirmStyles[variant]}`}>
          {loading ? '处理中...' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
