import { useState } from 'react';
import AppShell from './components/layout/AppShell';
import DashboardView from './views/DashboardView';
import SyncTasksView from './views/SyncTasksView';
import ActivityLogView from './views/ActivityLogView';
import SettingsView from './views/SettingsView';
import HelpView from './views/HelpView';
import AboutView from './views/AboutView';
import { SettingsProvider } from './context/SettingsContext';
import { PageTransition } from './components/ui/Animations';
import { ToastProvider } from './components/ui/Toast';
import ErrorBoundary from './components/ui/ErrorBoundary';

/**
 * SyncWatcher App - Main application component
 * State-based page routing with AppShell layout
 */
function App() {
  const [activeTab, setActiveTab] = useState('dashboard');

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

  return (
    <ErrorBoundary>
      <SettingsProvider>
        <ToastProvider>
          <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
            <PageTransition pageKey={activeTab}>
              {renderContent()}
            </PageTransition>
          </AppShell>
        </ToastProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}

export default App;
