import { CardAnimation } from './Animations';

export type InlineDialogTone = 'primary' | 'warning' | 'danger' | 'neutral';

export interface InlineDialogAction {
  key: string;
  label: string;
  tone?: InlineDialogTone;
}

interface InlineDialogModalProps {
  opened: boolean;
  title: string;
  message: string;
  actions: InlineDialogAction[];
  onAction: (key: string) => void;
}

function getButtonClassName(tone: InlineDialogTone): string {
  switch (tone) {
    case 'danger':
      return 'bg-[var(--color-accent-error)] text-white';
    case 'warning':
      return 'bg-[var(--color-accent-warning)] text-black';
    case 'primary':
      return 'bg-[var(--accent-main)] text-white';
    case 'neutral':
    default:
      return 'bg-white text-[var(--text-primary)]';
  }
}

export default function InlineDialogModal({
  opened,
  title,
  message,
  actions,
  onAction,
}: InlineDialogModalProps) {
  if (!opened) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
      <CardAnimation>
        <div className="neo-box w-full max-w-xl bg-[var(--bg-primary)] p-6 border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
          <h2 className="text-2xl font-heading font-black uppercase mb-4">
            {title}
          </h2>
          <p className="mb-6 whitespace-pre-wrap break-all text-sm text-[var(--text-primary)]">
            {message}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                onClick={() => onAction(action.key)}
                className={`px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] active:shadow-none transition-all ${getButtonClassName(action.tone ?? 'neutral')}`}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </CardAnimation>
    </div>
  );
}
