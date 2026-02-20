import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconDatabase,
  IconFolder,
  IconRefresh,
  IconShield,
  IconEye,
  IconBrandGithub,
} from '@tabler/icons-react';

function HelpView() {
  const { t } = useTranslation();

  const safetyChecklist = [
    t('help.safetyChecklist.checksumCost'),
    t('help.safetyChecklist.networkTargetSlow'),
    t('help.safetyChecklist.deleteMissingRemoved'),
    t('help.safetyChecklist.targetNewerReview'),
  ];

  const helpSections = [
    {
      id: 'syncBasics',
      icon: IconDatabase,
      title: t('help.sections.syncBasics.title'),
      description: t('help.sections.syncBasics.description'),
      features: [
        t('help.sections.syncBasics.oneWay'),
        t('help.sections.syncBasics.dryRunNoChanges'),
        t('help.sections.syncBasics.verifyAfterCopy'),
        t('help.sections.syncBasics.exclusionScope'),
      ],
    },
    {
      id: 'watchRuntime',
      icon: IconRefresh,
      title: t('help.sections.watchRuntime.title'),
      description: t('help.sections.watchRuntime.description'),
      features: [
        t('help.sections.watchRuntime.debounce'),
        t('help.sections.watchRuntime.queuedState'),
        t('help.sections.watchRuntime.concurrencyLimit'),
        t('help.sections.watchRuntime.initialQueue'),
      ],
    },
    {
      id: 'pathConflicts',
      icon: IconEye,
      title: t('help.sections.pathConflicts.title'),
      description: t('help.sections.pathConflicts.description'),
      features: [
        t('help.sections.pathConflicts.withinTaskOverlap'),
        t('help.sections.pathConflicts.targetUniqueness'),
        t('help.sections.pathConflicts.watchLoopRisk'),
      ],
    },
    {
      id: 'conflictOrphan',
      icon: IconShield,
      title: t('help.sections.conflictOrphan.title'),
      description: t('help.sections.conflictOrphan.description'),
      features: [
        t('help.sections.conflictOrphan.targetNewerActions'),
        t('help.sections.conflictOrphan.memorySession'),
        t('help.sections.conflictOrphan.autoUnmountSkip'),
        t('help.sections.conflictOrphan.orphanWorkflow'),
      ],
    },
    {
      id: 'uuidSource',
      icon: IconFolder,
      title: t('help.sections.uuidSource.title'),
      description: t('help.sections.uuidSource.description'),
      features: [
        t('help.sections.uuidSource.tokenResolve'),
        t('help.sections.uuidSource.notMounted'),
        t('help.sections.uuidSource.subPath'),
      ],
    },
  ];

  return (
    <div className="fade-in max-w-5xl space-y-6">
      <header className="mb-8 p-6 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] shadow-[4px_4px_0_0_var(--shadow-color)]">
        <h1 className="text-3xl font-heading font-black uppercase mb-1">{t('help.title')}</h1>
        <div className="font-mono text-xs border-l-4 border-[var(--accent-info)] pl-3">
          // USER_MANUAL_DB
        </div>
      </header>

      <section className="neo-box p-6 bg-[var(--color-accent-warning)]/10 border-3 border-[var(--color-accent-warning)]">
        <div className="flex items-start gap-3 mb-3">
          <div className="p-2 border-2 border-[var(--border-main)] bg-[var(--bg-primary)]">
            <IconAlertTriangle size={24} stroke={2} />
          </div>
          <div>
            <h2 className="text-lg font-bold uppercase">
              {t('help.safetyChecklist.title')}
            </h2>
            <p className="text-sm text-[var(--text-secondary)]">
              {t('help.safetyChecklist.description')}
            </p>
          </div>
        </div>
        <ul className="pl-4 space-y-2 list-none">
          {safetyChecklist.map((item) => (
            <li key={item} className="text-sm flex items-start gap-2">
              <span className="w-1.5 h-1.5 mt-1.5 bg-[var(--color-accent-warning)] shrink-0"></span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {helpSections.map((section) => {
          const Icon = section.icon;
          return (
            <article
              key={section.id}
              className="neo-box p-6 bg-[var(--bg-primary)] hover:translate-y-[-2px] transition-transform"
            >
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
            </article>
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

          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href="https://github.com/studiojin-dev/SyncWatcher/discussions"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-3 px-4 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] font-bold hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0_0_black] transition-all"
            >
              <IconBrandGithub size={20} />
              <span>{t('help.feedback.linkText')}</span>
            </a>

            <a
              href="https://github.com/studiojin-dev/SyncWatcher/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-3 px-4 bg-[var(--bg-secondary)] border-3 border-[var(--border-main)] font-bold hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[4px_4px_0_0_black] transition-all"
            >
              <IconBrandGithub size={20} />
              <span>{t('help.feedback.issueLinkText')}</span>
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

export default HelpView;
