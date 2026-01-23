import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Textarea, Button, Group, Alert, Text, Stack } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconExternalLink } from '@tabler/icons-react';
import * as yaml from 'js-yaml';
import { invoke } from '@tauri-apps/api/core';
import { YamlParseError } from '../../hooks/useYamlStore';

interface YamlEditorModalProps {
  opened: boolean;
  onClose: () => void;
  error: YamlParseError;
}

function YamlEditorModal({ opened, onClose, error }: YamlEditorModalProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState(error.rawContent);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Update content when error changes
  useEffect(() => {
    setContent(error.rawContent);
    setHasUnsavedChanges(false);
  }, [error.rawContent, opened]);

  // Track unsaved changes
  useEffect(() => {
    setHasUnsavedChanges(content !== error.rawContent);
  }, [content, error.rawContent]);

  // Watch for external file changes (polling every 1 second when modal is open)
  useEffect(() => {
    if (!opened) return;

    const interval = setInterval(async () => {
      try {
        const updated = await invoke<string>('read_yaml_file', {
          path: error.filePath
        });
        if (updated !== content) {
          setContent(updated);
          // Don't show toast during rapid external edits
        }
      } catch (err) {
        // File might not exist yet, silently ignore
        console.error('Failed to watch file:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [opened, error.filePath, content]);

  // Memoize line numbers calculation
  const lineNumbers = useMemo(() => {
    if (!content) return [];
    const lines = content.split('\n');
    return Array.from({ length: lines.length }, (_, i) => i + 1);
  }, [content]);

  // Validate YAML content
  const validateYaml = useCallback((yamlContent: string) => {
    try {
      yaml.load(yamlContent);
      setValidationError(null);
      setIsValid(true);
      return true;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown YAML error';
      setValidationError(errorMsg);
      setIsValid(false);
      return false;
    }
  }, []);

  // Validate on content change (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      validateYaml(content);
    }, 300);

    return () => clearTimeout(timer);
  }, [content, validateYaml]);

  // Handle save
  const handleSave = async () => {
    if (!isValid) {
      return;
    }

    try {
      await invoke('write_yaml_file', {
        path: error.filePath,
        content
      });
      setHasUnsavedChanges(false);
      onClose();
    } catch (err) {
      console.error('Failed to save YAML file:', err);
      setValidationError(`Failed to save: ${err}`);
    }
  };

  // Handle close with confirmation for unsaved changes
  const handleClose = () => {
    if (hasUnsavedChanges) {
      if (confirm(t('yamlEditor.unsavedChangesWarning'))) {
        onClose();
      }
    } else {
      onClose();
    }
  };

  // Open in external editor
  const openExternal = async () => {
    try {
      await invoke('open_in_editor', { path: error.filePath });
    } catch (err) {
      console.error('Failed to open external editor:', err);
      setValidationError(`Failed to open editor: ${err}`);
    }
  };

  // Jump to error line
  const jumpToError = () => {
    if (error.line) {
      const textarea = document.querySelector('textarea[name="yaml-editor"]') as HTMLTextAreaElement;
      if (textarea) {
        const lines = content.split('\n');
        let position = 0;
        for (let i = 0; i < error.line! - 1; i++) {
          position += lines[i].length + 1; // +1 for newline
        }
        textarea.focus();
        textarea.setSelectionRange(position, position);
      }
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={
        <Group gap="xs">
          <Text fw={500}>{t('yamlEditor.title')}</Text>
          <Text size="sm" c="dimmed">
            ({error.filePath.split('/').pop()})
          </Text>
        </Group>
      }
      size="xl"
      styles={{
        title: { width: '100%' }
      }}
    >
      <Stack gap="md">
        {/* Error Location Alert */}
        {error.line && (
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="red"
            title={t('yamlEditor.parseError')}
          >
            <Text size="sm">
              {t('yamlEditor.line')} <strong>{error.line}</strong>, {t('yamlEditor.column')} <strong>{error.column || '?'}</strong>: {error.message}
            </Text>
            <Button
              variant="light"
              size="xs"
              mt="xs"
              onClick={jumpToError}
            >
              {t('yamlEditor.jumpToError')}
            </Button>
          </Alert>
        )}

        {/* YAML Editor with Line Numbers */}
        <div style={{ position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '40px',
              background: 'var(--mantine-color-gray-0)',
              borderRight: '1px solid var(--mantine-color-gray-3)',
              padding: '12px 8px',
              fontFamily: 'monospace',
              fontSize: '13px',
              lineHeight: '1.6',
              color: 'var(--mantine-color-gray-5)',
              textAlign: 'right',
              userSelect: 'none',
              overflow: 'hidden',
            }}
          >
            {lineNumbers.map((num) => (
              <div
                key={num}
                style={{
                  fontWeight: error.line === num ? 'bold' : 'normal',
                  color: error.line === num ? 'var(--mantine-color-red-6)' : undefined
                }}
              >
                {num}
              </div>
            ))}
          </div>
          <Textarea
            name="yaml-editor"
            value={content}
            onChange={(e) => setContent(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Keyboard shortcuts
              if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (isValid) handleSave();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                handleClose();
              }
            }}
            aria-label={t('yamlEditor.placeholder')}
            aria-invalid={!isValid}
            aria-describedby={
              validationError ? 'validation-error-alert' : isValid ? 'valid-yaml-alert' : undefined
            }
            styles={{
              input: {
                fontFamily: 'Monaco, Menlo, Ubuntu Mono, Consolas, monospace',
                fontSize: '13px',
                lineHeight: '1.6',
                paddingLeft: '50px', // Space for line numbers
                minHeight: '400px',
              }
            }}
            minRows={20}
            placeholder={t('yamlEditor.placeholder')}
          />
        </div>

        {/* Validation Error */}
        {validationError && (
          <Alert
            id="validation-error-alert"
            icon={<IconAlertTriangle size={16} />}
            color="orange"
            title={t('yamlEditor.validationError')}
            role="alert"
          >
            {validationError}
          </Alert>
        )}

        {/* Validation Success */}
        {isValid && !validationError && (
          <Alert
            id="valid-yaml-alert"
            icon={<IconCheck size={16} />}
            color="teal"
            title={t('yamlEditor.validYaml')}
            role="status"
          >
            {t('yamlEditor.validYamlDescription')}
          </Alert>
        )}

        {/* Action Buttons */}
        <Group justify="flex-end">
          <Button
            variant="light"
            leftSection={<IconExternalLink size={16} />}
            onClick={openExternal}
          >
            {t('yamlEditor.openExternal')}
          </Button>
          <Button variant="light" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!isValid}
            color={isValid ? 'teal' : 'gray'}
          >
            {t('yamlEditor.saveAndReload')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default YamlEditorModal;
