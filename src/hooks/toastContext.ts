import { createContext } from 'react';

export const ToastContext = createContext<{
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
} | null>(null);
