import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconLicense, IconBrandGithub } from '@tabler/icons-react';
import { LicenseCard, LicenseData } from '../components/ui/LicenseCard';
import { useAppVersion } from '../hooks/useAppVersion';

function AboutView() {
  const { t } = useTranslation();
  const [showLicenses, setShowLicenses] = useState(false);
  const appVersion = useAppVersion();
  const [licenseData, setLicenseData] = useState<LicenseData[]>([]);
  const [loadingLicenses, setLoadingLicenses] = useState(false);

  const handleViewLicenses = async () => {
    try {
      if (showLicenses) {
        setShowLicenses(false);
        return;
      }

      setLoadingLicenses(true);
      // Try to fetch the generated licenses file (available in production build)
      const response = await fetch('/oss-licenses.json');
      if (!response.ok) {
        throw new Error('Licenses file not found');
      }
      const licenses = await response.json();
      setLicenseData(licenses);
      setShowLicenses(true);
    } catch (err) {
      console.warn('Failed to load licenses:', err);
      // Fallback: show simple alert since we can't display JSON nicely without data
      alert('Open Source Licenses are available in the production build (dist/oss-licenses.json).');
    } finally {
      setLoadingLicenses(false);
    }
  };

  return (
    <div className="fade-in">
      <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
        <h1 className="text-3xl font-heading font-black uppercase mb-1">
          {t('about.title')}
        </h1>
      </header>

      <div data-testid="about-content-container" className="flex flex-col gap-6 w-full">
        <div className="neo-box p-8 text-center bg-[var(--bg-primary)]">
          <div className="text-6xl mb-4 animate-bounce-slow">
            🔄
          </div>
          <h2 className="text-3xl font-heading font-black uppercase mb-2">
            SyncWatcher
          </h2>
          <div className="font-mono text-sm text-[var(--text-secondary)] mb-6">Version {appVersion}</div>

          <div className="pt-6 border-t-3 border-dashed border-[var(--border-main)] grid gap-4 text-left">
            <div className="flex justify-between items-center">
              <span className="font-bold text-[var(--text-secondary)]">{t('about.developer')}</span>
              <span className="font-mono font-bold">Studio Jin</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="font-bold text-[var(--text-secondary)]">{t('about.license')}</span>
            </div>

            <a
              href="https://github.com/kimjj81/SyncWatcher"
              target="_blank"
              className="mt-4 flex items-center justify-center gap-2 w-full py-3 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] font-bold hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0_0_black] transition-all"
            >
              <IconBrandGithub size={20} />
              <span>{t('about.viewOnGithub')}</span>
            </a>
          </div>
        </div>

        <div className="neo-box p-6 bg-[var(--bg-primary)]">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h3 className="text-lg font-bold uppercase mb-1">{t('about.openSourceLibraries')}</h3>
              <p className="text-sm text-[var(--text-secondary)]">
                {t('about.openSourceDescription')}
              </p>
            </div>
            <button
              onClick={handleViewLicenses}
              disabled={loadingLicenses}
              className="px-4 py-2 bg-[var(--accent-main)] text-white border-3 border-[var(--border-main)] font-bold uppercase hover:bg-[var(--accent-main)] hover:brightness-110 hover:shadow-[4px_4px_0_0_black] transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <IconLicense size={18} />
              {loadingLicenses ? t('common.loading') : (showLicenses ? t('common.close') : t('about.viewLicenses'))}
            </button>
          </div>
        </div>

        {showLicenses && (
          <div className="neo-box p-6 bg-[var(--bg-secondary)] animate-slide-up">
            <div className="flex justify-between items-center mb-4 border-b-3 border-[var(--border-main)] pb-2">
              <h3 className="text-lg font-bold uppercase">
                {t('about.licenses')} <span className="text-sm font-mono text-[var(--text-secondary)]">({licenseData.length})</span>
              </h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[600px] overflow-y-auto pr-2">
              {licenseData.map((license, index) => (
                <LicenseCard key={`${license.name}-${index}`} data={license} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AboutView;
