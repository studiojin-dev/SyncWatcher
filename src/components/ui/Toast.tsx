import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { IconCheck, IconX, IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
    id: string;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

/**
 * Hook to use toast notifications
 */
export function useToast(): ToastContextType {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}

interface ToastProviderProps {
    children: ReactNode;
}

/**
 * Toast notification provider
 * Auto-dismiss after 4 seconds
 */
export function ToastProvider({ children }: ToastProviderProps) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = useCallback((message: string, type: ToastType = 'info') => {
        const id = crypto.randomUUID();
        setToasts((prev) => [...prev, { id, message, type }]);
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <ToastContainer toasts={toasts} onRemove={removeToast} />
        </ToastContext.Provider>
    );
}

interface ToastContainerProps {
    toasts: Toast[];
    onRemove: (id: string) => void;
}

function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
    return (
        <div
            style={{
                position: 'fixed',
                bottom: 'var(--space-6)',
                right: 'var(--space-6)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                zIndex: 1000,
                pointerEvents: 'none',
            }}
        >
            <AnimatePresence>
                {toasts.map((toast) => (
                    <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
                ))}
            </AnimatePresence>
        </div>
    );
}

interface ToastItemProps {
    toast: Toast;
    onRemove: (id: string) => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
    useEffect(() => {
        const timer = setTimeout(() => {
            onRemove(toast.id);
        }, 4000);
        return () => clearTimeout(timer);
    }, [toast.id, onRemove]);

    const getIcon = () => {
        switch (toast.type) {
            case 'success':
                return <IconCheck size={16} />;
            case 'error':
                return <IconX size={16} />;
            case 'warning':
                return <IconAlertTriangle size={16} />;
            case 'info':
                return <IconInfoCircle size={16} />;
        }
    };

    const getStyles = () => {
        switch (toast.type) {
            case 'success':
                return {
                    background: 'var(--status-success-bg)',
                    borderColor: 'var(--status-success-text)',
                    iconColor: 'var(--status-success-text)',
                };
            case 'error':
                return {
                    background: 'var(--status-error-bg)',
                    borderColor: 'var(--status-error-text)',
                    iconColor: 'var(--status-error-text)',
                };
            case 'warning':
                return {
                    background: 'var(--status-warning-bg)',
                    borderColor: 'var(--status-warning-text)',
                    iconColor: 'var(--status-warning-text)',
                };
            case 'info':
                return {
                    background: 'var(--bg-tertiary)',
                    borderColor: 'var(--accent-border)',
                    iconColor: 'var(--text-secondary)',
                };
        }
    };

    const styles = getStyles();

    return (
        <motion.div
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.9 }}
            transition={{ duration: 0.2, ease: [0.33, 1, 0.68, 1] }}
            style={{
                background: styles.background,
                border: `1px solid ${styles.borderColor}`,
                borderRadius: '8px',
                padding: 'var(--space-3) var(--space-4)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
                pointerEvents: 'auto',
                maxWidth: '320px',
            }}
        >
            <span style={{ color: styles.iconColor }}>{getIcon()}</span>
            <span className="text-sm">{toast.message}</span>
            <button
                onClick={() => onRemove(toast.id)}
                className="btn-ghost"
                style={{
                    padding: 'var(--space-1)',
                    marginLeft: 'auto',
                    border: 'none',
                    background: 'transparent',
                }}
            >
                <IconX size={14} />
            </button>
        </motion.div>
    );
}

export default ToastProvider;
