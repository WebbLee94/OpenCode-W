import React, { useEffect, useId, useRef } from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /**
   * 是否**禁止**关闭 —— 由调用方决定，通用组件不内置任何业务语义。
   *
   * 用于「下载 / 安装进行中」这类中途不能打断的流程：
   * 关闭按钮置灰（并从 Tab 序列中移除），Esc 与遮罩点击也不再关闭，
   * 避免用户点了却毫无反应、以为按钮坏了。
   */
  closeDisabled?: boolean;
}

const sizeStyles = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' };

/** 弹窗内可聚焦元素（用于 Tab 焦点循环） */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function Modal({ isOpen, onClose, title, children, size = 'md', closeDisabled = false }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Esc 关闭（禁止关闭时按 Esc 无效）
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (closeDisabled) return;
      onClose();
    };
    if (isOpen) document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose, closeDisabled]);

  // 打开时把焦点移进弹窗，关闭时归还给打开弹窗的元素
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 聚焦弹窗容器本身：读屏软件会先播报「版本更新，对话框」，
    // 也不会把焦点默认落在「关闭」按钮上（误按 Enter 就把弹窗关了）。
    panelRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [isOpen]);

  // Tab 焦点循环：不让焦点跑到弹窗外面去
  useEffect(() => {
    if (!isOpen) return;
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleTab, true);
    return () => document.removeEventListener('keydown', handleTab, true);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === overlayRef.current && !closeDisabled) onClose(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`bg-white rounded-lg shadow-xl w-full ${sizeStyles[size]} mx-4 focus:outline-none`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 id={titleId} className="text-lg font-semibold text-gray-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-disabled={closeDisabled || undefined}
            aria-label="关闭"
            title={closeDisabled ? '当前状态不允许关闭' : undefined}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400"
          >&times;</button>
        </div>
        <div className="px-4 py-4">{children}</div>
      </div>
    </div>
  );
}
