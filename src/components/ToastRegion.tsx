export interface ToastItem {
  id: string;
  type: 'error' | 'info';
  message: string;
}

interface ToastRegionProps {
  toasts: ToastItem[];
}

export function ToastRegion({ toasts }: ToastRegionProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toast-region" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <div key={toast.id} className={toast.type === 'error' ? 'toast error' : 'toast'}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
