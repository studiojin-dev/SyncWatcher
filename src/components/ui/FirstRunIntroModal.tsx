import { useTranslation } from 'react-i18next';
import { CardAnimation } from './Animations';

interface FirstRunIntroModalProps {
  opened: boolean;
  busy?: boolean;
  onDismiss: () => void;
  onEnable: () => void;
}

export default function FirstRunIntroModal({
  opened,
  busy = false,
  onDismiss,
  onEnable,
}: FirstRunIntroModalProps) {
  const { t } = useTranslation();

  if (!opened) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
      <CardAnimation>
        <div className="neo-box w-full max-w-xl bg-[var(--bg-primary)] p-6 border-3 border-[var(--border-main)] shadow-[8px_8px_0_0_var(--shadow-color)]">
          <div className="mb-4">
            <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--accent-warning)]">
              FIRST RUN
            </p>
            <h2 className="text-2xl font-heading font-black uppercase">
              {t('app.firstRunIntroTitle')}
            </h2>
          </div>

          <p className="mb-4 text-sm text-[var(--text-primary)]">
            {t('app.firstRunIntroDescription')}
          </p>

          <div className="mb-5 space-y-3 text-sm">
            <div className="border-l-4 border-[var(--accent-main)] pl-3">
              {t('app.firstRunIntroBehavior')}
            </div>
            <div className="border-l-4 border-[var(--accent-success)] pl-3">
              {t('app.firstRunIntroAutostart')}
            </div>
            <div className="font-mono text-xs text-[var(--text-secondary)]">
              {t('app.firstRunIntroSettingsHint')}
            </div>
          </div>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy}
              className="px-4 py-2 font-bold uppercase border-2 border-[var(--border-main)] hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('app.firstRunIntroLater')}
            </button>
            <button
              type="button"
              onClick={onEnable}
              disabled={busy}
              className="px-4 py-2 font-bold uppercase bg-[var(--accent-main)] text-white border-2 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)] hover:shadow-[2px_2px_0_0_var(--shadow-color)] active:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? t('common.loading') : t('app.firstRunIntroEnable')}
            </button>
          </div>
        </div>
      </CardAnimation>
    </div>
  );
}
