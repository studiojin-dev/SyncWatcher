import { useTranslation } from 'react-i18next';
import {
  IconDatabase,
  IconShield,
  IconRefresh,
  IconEye,
  IconBrandGithub,
} from '@tabler/icons-react';

function HelpView() {
  const { t } = useTranslation();

  const helpSections = [
    {
      icon: IconDatabase,
      title: t('help.syncEngine.title'),
      description: t('help.syncEngine.description'),
      features: [
        t('help.syncEngine.oneWaySync'),
        t('help.syncEngine.dryRun'),
        t('help.syncEngine.checksum'),
      ],
    },
    {
      icon: IconRefresh,
      title: t('help.watchMode.title'),
      description: t('help.watchMode.description'),
      features: [
        t('help.watchMode.autoDetection'),
        t('help.watchMode.realTime'),
      ],
    },
    {
      icon: IconRefresh,
      title: t('help.backgroundMode.title'),
      description: t('help.backgroundMode.description'),
      features: [
        t('help.backgroundMode.closeAction'),
        t('help.backgroundMode.trayOpen'),
        t('help.backgroundMode.trayQuit'),
      ],
    },
    {
      icon: IconShield,
      title: t('help.security.title'),
      description: t('help.security.description'),
      features: [
        t('help.security.verifyAfterCopy'),
      ],
    },
    {
      icon: IconEye,
      title: t('help.preview.title'),
      description: t('help.preview.description'),
      features: [
        t('help.preview.whatIf'),
        t('help.preview.noChanges'),
      ],
    },
  ];

  return (
    <div className="fade-in max-w-4xl">
      <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
        <h1 className="text-3xl font-heading font-black uppercase mb-1">{t('help.title')}</h1>
        <div className="font-mono text-xs border-l-4 border-[var(--accent-info)] pl-3">
          // USER_MANUAL_DB
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {helpSections.map((section, index) => {
          const Icon = section.icon;
          return (
            <div key={index} className="neo-box p-6 bg-[var(--bg-primary)] hover:translate-y-[-2px] transition-transform">
              <div className="flex items-start gap-4 mb-4">
                <div className="p-3 rounded-none border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] shadow-[2px_2px_0_0_var(--shadow-color)]">
                  <Icon size={32} stroke={1.5} />
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold uppercase mb-1 border-b-2 border-dashed border-[var(--border-main)] inline-block">
                    {section.title}
                  </h3>
                  <p className="text-sm text-[var(--text-secondary)] mt-1">{section.description}</p>
                </div>
              </div>

              <ul className="pl-4 space-y-2 list-none">
                {section.features.map((feature, idx) => (
                  <li key={idx} className="text-sm flex items-center gap-2">
                    <span className="w-1.5 h-1.5 bg-[var(--accent-main)]"></span>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <section className="neo-box mt-6 p-6 bg-[var(--bg-primary)]">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold uppercase mb-1">
              {t('help.feedback.title')}
            </h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {t('help.feedback.description')}
            </p>
          </div>

          <a
            href="https://github.com/studiojin-dev/SyncWatcher/discussions"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 py-3 px-4 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] font-bold hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0_0_black] transition-all"
          >
            <IconBrandGithub size={20} />
            <span>{t('help.feedback.linkText')}</span>
          </a>
        </div>
      </section>
    </div>
  );
}

export default HelpView;
