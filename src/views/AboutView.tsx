import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconLicense, IconBrandGithub } from '@tabler/icons-react';
import { invoke } from '@tauri-apps/api/core';

function AboutView() {
  const { t } = useTranslation();
  const [showLicenses, setShowLicenses] = useState(false);

  const appVersion = '0.1.0';

  const handleGenerateLicenses = async () => {
    try {
      await invoke('generate_licenses_report');
      setShowLicenses(true);
    } catch (err) {
      console.error('Failed to generate licenses:', err);
    }
  };

  return (
    <div>
      <header style={{ marginBottom: 'var(--space-8)' }}>
        <h1 className="text-xl">{t('about.title')}</h1>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', maxWidth: '600px' }}>
        <div className="card">
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-6)' }}>
            <div style={{ 
              fontSize: '48px', 
              marginBottom: 'var(--space-4)' 
            }}>
              🔄
            </div>
            <h2 className="text-xl" style={{ marginBottom: 'var(--space-2)' }}>
              SyncWatcher
            </h2>
            <div className="text-sm text-tertiary">Version {appVersion}</div>
          </div>

          <div style={{ borderTop: '1px solid var(--accent-border)', paddingTop: 'var(--space-4)' }}>
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <div className="text-sm text-secondary" style={{ marginBottom: 'var(--space-1)' }}>
                {t('about.developer')}
              </div>
              <div className="text-base">Studio Jin</div>
            </div>

            <div style={{ marginBottom: 'var(--space-4)' }}>
              <div className="text-sm text-secondary" style={{ marginBottom: 'var(--space-1)' }}>
                {t('about.license')}
              </div>
              <div className="text-base">MIT License</div>
            </div>

            <a 
              href="https://github.com/studiojin/syncwatcher"
              target="_blank"
              className="btn-ghost"
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
            >
              <IconBrandGithub size={20} />
              <span>{t('about.viewOnGithub')}</span>
            </a>
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
            <div>
              <h3 className="text-base">{t('about.opensourceLibraries')}</h3>
              <p className="text-sm text-tertiary">
                {t('about.opensourceDescription')}
              </p>
            </div>
            <button
              onClick={handleGenerateLicenses}
              className="btn-primary"
            >
              <IconLicense size={18} style={{ marginRight: '8px' }} />
              {t('about.generateReport')}
            </button>
          </div>
        </div>

        {showLicenses && (
          <div className="card">
            <h3 className="text-base" style={{ marginBottom: 'var(--space-4)' }}>
              {t('about.licenses')}
            </h3>
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <pre className="text-sm">
{/* License report content will be populated dynamically */}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AboutView;
