import { useState, useEffect, useCallback } from 'react';
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
  const [content, setContent] = useState(error.rawContent);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(false);
  const [lineNumbers, setLineNumbers] = useState<number[]>([]);

  // Update content when error changes
  useEffect(() => {
    setContent(error.rawContent);
  }, [error.rawContent, opened]);

  // Update line numbers when content changes
  useEffect(() => {
    const lines = content.split('\n');
    setLineNumbers(Array.from({ length: lines.length }, (_, i) => i + 1));
  }, [content]);

  // Validate YAML content
  const validateYaml = useCallback((yamlContent: string) => {
    try {
      yaml.load(yamlContent);
      setValidationError(null);
      setIsValid(true);
      return true;
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown YAML error';
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
      onClose();
    } catch (err) {
      console.error('Failed to save YAML file:', err);
      setValidationError(`Failed to save: ${err}`);
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
      onClose={onClose}
      title={
        <Group gap="xs">
          <Text fw={500}>Edit YAML File</Text>
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
            title="YAML Parsing Error"
          >
            <Text size="sm">
              Line <strong>{error.line}</strong>, Column <strong>{error.column || '?'}</strong>: {error.message}
            </Text>
            <Button
              variant="light"
              size="xs"
              mt="xs"
              onClick={jumpToError}
            >
              Jump to Error Line
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
            placeholder="Enter YAML content..."
          />
        </div>

        {/* Validation Error */}
        {validationError && (
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="orange"
            title="Validation Error"
          >
            {validationError}
          </Alert>
        )}

        {/* Validation Success */}
        {isValid && !validationError && (
          <Alert
            icon={<IconCheck size={16} />}
            color="teal"
            title="Valid YAML"
          >
            This YAML is valid and ready to save.
          </Alert>
        )}

        {/* Action Buttons */}
        <Group justify="flex-end">
          <Button
            variant="light"
            leftSection={<IconExternalLink size={16} />}
            onClick={openExternal}
          >
            Open in External Editor
          </Button>
          <Button variant="light" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!isValid}
            color={isValid ? 'teal' : 'gray'}
          >
            Save & Reload
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default YamlEditorModal;
