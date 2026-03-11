// Type guards for YAML exceptions

export interface YAMLException {
  name: string;
  message: string;
  mark?: {
    line: number;
    column: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isYamlMark(
  value: unknown,
): value is { line: number; column: number } {
  return (
    isRecord(value) &&
    typeof value.line === 'number' &&
    typeof value.column === 'number'
  );
}

/**
 * Type guard to check if an error is a YAMLException from js-yaml
 */
export function isYAMLException(err: unknown): err is YAMLException {
  if (!isRecord(err)) {
    return false;
  }

  return (
    typeof err.name === 'string' &&
    typeof err.message === 'string'
  );
}

/**
 * Type guard to check if an error has mark property (line/column info)
 */
export function hasMark(
  err: unknown,
): err is YAMLException & { mark: { line: number; column: number } } {
  return isYAMLException(err) && isYamlMark(err.mark);
}
