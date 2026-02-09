import { StrictMode, Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import './styles/design-system.css';
import './index.css';
import './i18n';
import InitialBootOverlay from './components/ui/InitialBootOverlay';

const App = lazy(() => import('./App'));

// Mantine theme customization to match design system
const theme = createTheme({
  fontFamily: 'Pretendard Variable, Pretendard, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, SF Mono, Cascadia Code, Consolas, monospace',
  primaryColor: 'gray',
  defaultRadius: 'sm',
  components: {
    Select: {
      styles: {
        input: {
          fontSize: '11px',
        },
      },
    },
    Switch: {
      styles: {
        track: {
          cursor: 'pointer',
        },
      },
    },
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MantineProvider theme={theme}>
      <Suspense fallback={<InitialBootOverlay />}>
        <App />
      </Suspense>
    </MantineProvider>
  </StrictMode>,
);
