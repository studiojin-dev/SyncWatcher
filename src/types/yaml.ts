// Type guards for YAML exceptions

export interface YAMLException {
  name: string;
  message: string;
  mark?: {
    line: number;
    column: number;
  };
}

/**
 * Type guard to check if an error is a YAMLException from js-yaml
 */
export function isYAMLException(err: unknown): err is YAMLException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    'message' in err &&
    typeof (err as any).name === 'string' &&
    typeof (err as any).message === 'string'
  );
}

/**
 * Type guard to check if an error has mark property (line/column info)
 */
export function hasMark(err: unknown): err is YAMLException & { mark: { line: number; column: number } } {
  return (
    isYAMLException(err) &&
    'mark' in err &&
    typeof (err as any).mark === 'object' &&
    (err as any).mark !== null &&
    'line' in (err as any).mark &&
    'column' in (err as any).mark
  );
}
