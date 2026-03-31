import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';

interface TooltipProps {
  children: ReactElement;
  content: string;
  className?: string;
}

interface TooltipTriggerProps {
  'aria-describedby'?: string;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

export function Tooltip({ children, content, className }: TooltipProps) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  if (!isValidElement(children)) {
    throw new Error('Tooltip expects a single valid React element child.');
  }
  const triggerElement = children as ReactElement<TooltipTriggerProps>;

  const handleMouseEnter = (event: MouseEvent<HTMLElement>) => {
    triggerElement.props.onMouseEnter?.(event);
    setVisible(true);
  };

  const handleMouseLeave = (event: MouseEvent<HTMLElement>) => {
    triggerElement.props.onMouseLeave?.(event);
    setVisible(false);
  };

  const handleFocus = (event: FocusEvent<HTMLElement>) => {
    triggerElement.props.onFocus?.(event);
    setVisible(true);
  };

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    triggerElement.props.onBlur?.(event);
    setVisible(false);
  };

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    triggerElement.props.onClick?.(event);
    setVisible((current) => !current);
  };

  const trigger = cloneElement(triggerElement, {
    'aria-describedby': visible ? tooltipId : undefined,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onClick: handleClick,
  });

  return (
    <div
      className={className}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      {trigger}
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
