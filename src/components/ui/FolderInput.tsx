import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';

interface FolderInputProps {
  value: string;
  onChange: (value: string) => void;
  name: string;
  label: string;
}

function FolderInput({ value, onChange, name, label }: FolderInputProps) {
  const { t } = useTranslation();

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true });
      if (selected) {
        onChange(selected as string);
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    }
  };

  return (
    <div>
      <label className="text-sm text-secondary" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="btn-ghost font-mono"
          style={{ flex: 1 }}
          placeholder={t('syncTasks.source')}
          required
        />
        <button
          type="button"
          onClick={handleBrowse}
          className="btn-ghost"
          title={t('syncTasks.browse')}
        >
          📁
        </button>
      </div>
    </div>
  );
}

export default FolderInput;
