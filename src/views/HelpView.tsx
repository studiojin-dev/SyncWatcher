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
    <div>
      <header style={{ marginBottom: 'var(--space-8)' }}>
        <h1 className="text-xl">{t('help.title')}</h1>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {helpSections.map((section, index) => {
          const Icon = section.icon;
          return (
            <div key={index} className="card">
              <div style={{ display: 'flex', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
                <div style={{ 
                  padding: '12px', 
                  borderRadius: '8px', 
                  background: 'var(--bg-secondary)' 
                }}>
                  <Icon size={32} />
                </div>
                <div style={{ flex: 1 }}>
                  <h3 className="text-base" style={{ marginBottom: 'var(--space-1)' }}>
                    {section.title}
                  </h3>
                  <p className="text-sm text-secondary">{section.description}</p>
                </div>
              </div>
              
              <ul style={{ paddingLeft: 'var(--space-6)' }}>
                {section.features.map((feature, idx) => (
                  <li key={idx} className="text-sm" style={{ marginBottom: 'var(--space-2)' }}>
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
