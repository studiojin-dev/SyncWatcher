import { Modal, Text } from '@mantine/core';

interface ErrorModalProps {
  opened: boolean;
  onClose: () => void;
  error: Error | string;
}

function ErrorModal({ opened, onClose, error }: ErrorModalProps) {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const stackTrace = typeof error === 'object' ? error.stack : undefined;

  return (
    <Modal opened={opened} onClose={onClose} title="Error" size="lg">
      <Text size="lg">{errorMessage}</Text>
      {stackTrace && (
        <details style={{ marginTop: 'var(--space-4)' }}>
          <summary className="text-xs text-tertiary">Stack Trace</summary>
          <pre className="text-sm" style={{ 
            background: 'var(--bg-secondary)', 
            padding: 'var(--space-2)', 
            borderRadius: '4px',
            overflow: 'auto' 
          }}>
            {stackTrace}
          </pre>
        </details>
      )}
    </Modal>
  );
}

export default ErrorModal;
