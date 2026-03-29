import { useId, useState, type ReactNode } from 'react';

interface TooltipProps {
  children: ReactNode;
  content: string;
  className?: string;
}

export function Tooltip({ children, content, className }: TooltipProps) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);

  return (
    <div
      className={className}
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      onClick={() => setVisible((current) => !current)}
      aria-describedby={visible ? tooltipId : undefined}
    >
      {children}
      {visible && (
        <div
          id={tooltipId}
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            maxWidth: '320px',
            whiteSpace: 'normal',
            zIndex: 1000,
            marginBottom: '4px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}
