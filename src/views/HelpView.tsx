import { useTranslation } from 'react-i18next';
import { IconDatabase, IconShield, IconRefresh, IconEye } from '@tabler/icons-react';

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
      icon: IconShield,
      title: t('help.security.title'),
      description: t('help.security.description'),
      features: [
        t('help.security.verifyAfterCopy'),
        t('help.security.deleteMissing'),
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
    </div>
  );

}

export default HelpView;
