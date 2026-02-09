import { lazy, Suspense, useState } from 'react';
import AppShell from './components/layout/AppShell';
import { useSettings } from './hooks/useSettings';
import { SettingsProvider } from './context/SettingsContext';
import { useSyncTasksContext, SyncTasksProvider } from './context/SyncTasksContext';
import { useExclusionSetsContext, ExclusionSetsProvider } from './context/ExclusionSetsContext';
import StartupProgressOverlay from './components/ui/StartupProgressOverlay';
import { PageTransition } from './components/ui/Animations';
import { ToastProvider } from './components/ui/Toast';
import ErrorBoundary from './components/ui/ErrorBoundary';
import BackendRuntimeBridge, { type InitialRuntimeSyncState } from './components/runtime/BackendRuntimeBridge';

const DashboardView = lazy(() => import('./views/DashboardView'));
const SyncTasksView = lazy(() => import('./views/SyncTasksView'));
const ActivityLogView = lazy(() => import('./views/ActivityLogView'));
const SettingsView = lazy(() => import('./views/SettingsView'));
const HelpView = lazy(() => import('./views/HelpView'));
const AboutView = lazy(() => import('./views/AboutView'));

/**
 * SyncWatcher App - Main application component
 * State-based page routing with AppShell layout
 */
function AppContent() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const { loaded: settingsLoaded } = useSettings();
  const { loaded: tasksLoaded } = useSyncTasksContext();
  const { loaded: setsLoaded } = useExclusionSetsContext();
  const [initialRuntimeSync, setInitialRuntimeSync] = useState<InitialRuntimeSyncState>('idle');

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <DashboardView />;
      case 'sync-tasks':
        return <SyncTasksView />;
      case 'activity-log':
        return <ActivityLogView />;
      case 'settings':
        return <SettingsView />;
      case 'help':
        return <HelpView />;
      case 'about':
        return <AboutView />;
      default:
        return <DashboardView />;
    }
  };

  const startupComplete =
    settingsLoaded &&
    tasksLoaded &&
    setsLoaded &&
    (initialRuntimeSync === 'success' || initialRuntimeSync === 'error');
  const canRenderAppShell = settingsLoaded && tasksLoaded && setsLoaded;

  return (
    <>
      <BackendRuntimeBridge onInitialRuntimeSyncChange={setInitialRuntimeSync} />
      {canRenderAppShell ? (
        <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
          <Suspense
            fallback={(
              <div className="neo-box p-6 bg-[var(--bg-secondary)]">
                <p className="font-mono text-sm uppercase text-[var(--text-secondary)]">
                  Loading view...
                </p>
              </div>
            )}
          >
            <PageTransition pageKey={activeTab}>
              {renderContent()}
            </PageTransition>
          </Suspense>
        </AppShell>
      ) : null}
      <StartupProgressOverlay
        settingsLoaded={settingsLoaded}
        tasksLoaded={tasksLoaded}
        exclusionSetsLoaded={setsLoaded}
        initialRuntimeSync={initialRuntimeSync}
        visible={!startupComplete}
      />
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <SyncTasksProvider>
          <ExclusionSetsProvider>
            <ToastProvider>
              <AppContent />
            </ToastProvider>
          </ExclusionSetsProvider>
        </SyncTasksProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}

export default App;
