type BootTheme = 'light' | 'dark';

function resolveBootTheme(): BootTheme {
  try {
    const explicitTheme = document.documentElement.getAttribute('data-theme');
    if (explicitTheme === 'light' || explicitTheme === 'dark') {
      return explicitTheme;
    }
  } catch {
    // Ignore DOM access errors and continue with stored setting.
  }

  try {
    const rawSettings = localStorage.getItem('syncwatcher_settings');
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings) as { theme?: 'light' | 'dark' | 'system' };
      if (parsed.theme === 'light' || parsed.theme === 'dark') {
        return parsed.theme;
      }
    }
  } catch {
    // Ignore parse/storage errors and continue with system preference.
  }

  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch {
    // Fallback below.
  }

  return 'light';
}

function InitialBootOverlay() {
  const theme = resolveBootTheme();
  const colors =
    theme === 'dark'
      ? {
          background: '#0b0d12',
          foreground: '#ffffff',
          cardBackground: 'rgba(0, 0, 0, 0.35)',
          border: 'rgba(255, 255, 255, 0.2)',
          track: 'rgba(255, 255, 255, 0.15)',
          bar: '#7dd3fc',
        }
      : {
          background: '#f7f8fc',
          foreground: '#141821',
          cardBackground: 'rgba(255, 255, 255, 0.85)',
          border: 'rgba(20, 24, 33, 0.2)',
          track: 'rgba(20, 24, 33, 0.15)',
          bar: '#0ea5e9',
        };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: colors.background,
        color: colors.foreground,
      }}
    >
      <div
        style={{
          width: 'min(640px, 100%)',
          borderRadius: 8,
          border: `1px solid ${colors.border}`,
          background: colors.cardBackground,
          padding: 24,
        }}
      >
        <p style={{ margin: '0 0 8px', fontFamily: 'monospace', fontSize: 12, letterSpacing: '0.18em', opacity: 0.7 }}>
          SYNCWATCHER
        </p>
        <h1 style={{ margin: '0 0 8px', fontSize: 28, fontWeight: 700 }}>
          Starting application...
        </h1>
        <p style={{ margin: '0 0 20px', fontFamily: 'monospace', fontSize: 14, opacity: 0.75 }}>
          Loading UI modules
        </p>
        <div style={{ height: 8, overflow: 'hidden', borderRadius: 999, background: colors.track }}>
          <div
            style={{
              width: '50%',
              height: '100%',
              borderRadius: 999,
              background: colors.bar,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default InitialBootOverlay;
