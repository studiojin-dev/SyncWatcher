import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';

interface McpStdioConfigExample {
  command: string;
  args: string[];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function McpConfigExampleCard() {
  const { t } = useTranslation();
  const [example, setExample] = useState<McpStdioConfigExample | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void invoke<McpStdioConfigExample>('get_mcp_stdio_config_example')
      .then((value) => {
        if (!cancelled) {
          setExample(value);
          setLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(getErrorMessage(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleReloadExample = async () => {
    try {
      setLoadError(null);
      const value = await invoke<McpStdioConfigExample>('get_mcp_stdio_config_example');
      setExample(value);
    } catch (error) {
      setLoadError(getErrorMessage(error));
    }
  };

  const handleRegenerateToken = async () => {
    setRegenerating(true);
    setRegenerateError(null);
    try {
      const value = await invoke<McpStdioConfigExample>('regenerate_mcp_auth_token');
      setExample(value);
    } catch (error) {
      setRegenerateError(getErrorMessage(error));
    } finally {
      setRegenerating(false);
    }
  };

  if (!example && loadError) {
    return (
      <div className="border-2 border-[var(--color-accent-error)] bg-[var(--bg-primary)] p-4">
        <div className="text-xs font-bold uppercase text-[var(--color-accent-error)]">
          {t('settings.mcpConfigExampleTitle')}
        </div>
        <p className="mt-2 text-sm text-[var(--color-accent-error)]">{loadError}</p>
        <button
          type="button"
          onClick={() => {
            void handleReloadExample();
          }}
          className="mt-3 border-3 border-[var(--border-main)] bg-[var(--bg-secondary)] px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!example) {
    return (
      <div className="border-2 border-[var(--border-main)] bg-[var(--bg-primary)] p-4 text-xs text-[var(--text-secondary)]">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="border-2 border-[var(--border-main)] bg-[var(--bg-primary)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="font-bold mb-2">{t('settings.mcpConfigExampleTitle')}</div>
          <p className="text-xs text-[var(--text-secondary)] mb-3">
            {t('settings.mcpConfigExampleDesc')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void handleRegenerateToken();
          }}
          disabled={regenerating}
          className="border-3 border-[var(--border-main)] bg-[var(--bg-secondary)] px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {regenerating ? t('settings.mcpRegeneratingToken') : t('settings.mcpRegenerateToken')}
        </button>
      </div>
      {regenerateError ? (
        <div className="mb-3 border-2 border-[var(--color-accent-error)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--color-accent-error)]">
          {regenerateError}
        </div>
      ) : null}
      <pre className="whitespace-pre-wrap break-all bg-[var(--bg-secondary)] border-2 border-[var(--border-main)] p-3 text-xs font-mono">
        {JSON.stringify(example, null, 2)}
      </pre>
    </div>
  );
}

export default McpConfigExampleCard;
