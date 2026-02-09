import { useTranslation } from 'react-i18next';
import type { InitialRuntimeSyncState } from '../runtime/BackendRuntimeBridge';

interface StartupProgressOverlayProps {
    settingsLoaded: boolean;
    tasksLoaded: boolean;
    exclusionSetsLoaded: boolean;
    initialRuntimeSync: InitialRuntimeSyncState;
    visible: boolean;
}

interface StartupStep {
    key: 'settings' | 'tasks' | 'exclusionSets' | 'runtime';
    completed: boolean;
    inProgress: boolean;
}

function StartupProgressOverlay({
    settingsLoaded,
    tasksLoaded,
    exclusionSetsLoaded,
    initialRuntimeSync,
    visible,
}: StartupProgressOverlayProps) {
    const { t } = useTranslation();

    if (!visible) {
        return null;
    }

    const runtimeCompleted = initialRuntimeSync === 'success' || initialRuntimeSync === 'error';
    const runtimeInProgress = initialRuntimeSync === 'pending';

    const steps: StartupStep[] = [
        { key: 'settings', completed: settingsLoaded, inProgress: !settingsLoaded },
        { key: 'tasks', completed: tasksLoaded, inProgress: settingsLoaded && !tasksLoaded },
        {
            key: 'exclusionSets',
            completed: exclusionSetsLoaded,
            inProgress: settingsLoaded && tasksLoaded && !exclusionSetsLoaded,
        },
        {
            key: 'runtime',
            completed: runtimeCompleted,
            inProgress: settingsLoaded && tasksLoaded && exclusionSetsLoaded && runtimeInProgress,
        },
    ];

    const completedCount = steps.filter((step) => step.completed).length;
    const progressPercent = completedCount * 25;

    return (
        <div className="fixed inset-0 z-[1200] bg-black/55 backdrop-blur-sm flex items-center justify-center p-6">
            <div className="neo-box w-full max-w-xl p-6 bg-[var(--bg-primary)]">
                <h2 className="text-2xl font-heading font-black uppercase mb-2">
                    {t('startup.title')}
                </h2>
                <p className="text-sm font-mono text-[var(--text-secondary)] mb-5">
                    {t('startup.description')}
                </p>

                <div className="mb-5 border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] h-6 overflow-hidden">
                    <div
                        className="h-full bg-[var(--accent-main)] transition-all duration-200 ease-out"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>

                <div className="space-y-2">
                    {steps.map((step) => (
                        <div
                            key={step.key}
                            className="flex items-center justify-between border-2 border-[var(--border-main)] bg-[var(--bg-secondary)] px-3 py-2"
                        >
                            <span className="font-mono text-sm uppercase">
                                {t(`startup.step.${step.key}`)}
                            </span>
                            <span className="font-mono text-xs">
                                {step.completed ? 'DONE' : step.inProgress ? 'LOADING' : 'PENDING'}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default StartupProgressOverlay;
