import { useState } from 'react';
import AppShell from './components/layout/AppShell';
import DashboardView from './views/DashboardView';
import SyncTasksView from './views/SyncTasksView';
import ActivityLogView from './views/ActivityLogView';
import SettingsView from './views/SettingsView';
import { useSettings } from './hooks/useSettings';
import { PageTransition } from './components/ui/Animations';
import { ToastProvider } from './components/ui/Toast';

/**
 * SyncWatcher App - Main application component
 * State-based page routing with AppShell layout
 */
function App() {
  const [activeTab, setActiveTab] = useState('dashboard');

  // Initialize settings (applies theme/language)
  useSettings();

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
      default:
        return <DashboardView />;
    }
  };

  return (
    <ToastProvider>
      <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
        <PageTransition pageKey={activeTab}>
          {renderContent()}
        </PageTransition>
      </AppShell>
    </ToastProvider>
  );
}

export default App;
