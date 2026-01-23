import { useState, useEffect, useCallback } from 'react';
import * as yaml from 'js-yaml';
import { invoke } from '@tauri-apps/api/core';
import { isYAMLException, hasMark } from '../types/yaml';

interface YamlStoreOptions<T> {
  fileName: string;
  defaultData: T;
}

// Maximum YAML file size (1MB) for security
const MAX_YAML_SIZE = 1024 * 1024;

// Timeout for YAML parsing (5 seconds)
const YAML_PARSE_TIMEOUT = 5000;

// Error types for better error handling
export interface YamlParseError {
  type: 'PARSE_ERROR';
  message: string;
  line?: number;
  column?: number;
  filePath: string;
  rawContent: string;
}

export type YamlStoreError = YamlParseError;

export function useYamlStore<T extends Record<string, any>>({
  fileName,
  defaultData,
}: YamlStoreOptions<T>) {
  const [data, setData] = useState<T>(defaultData);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<YamlStoreError | null>(null);

  const loadData = useCallback(async () => {
    try {
      const appDataDir = await invoke<string>('get_app_config_dir');
      const filePath = await invoke<string>('join_paths', {
        path1: appDataDir,
        path2: fileName
      });

      // Check if file exists
      const exists = await invoke<boolean>('file_exists', { path: filePath });

      if (!exists) {
        // File doesn't exist - create it with default data
        console.info(`${fileName} does not exist, creating with defaults`);
        await invoke('ensure_directory_exists', { path: appDataDir });
        const yamlContent = yaml.dump(defaultData, { indent: 2, lineWidth: -1 });
        await invoke('write_yaml_file', { path: filePath, content: yamlContent });
        setData(defaultData);
        setError(null);
        setLoaded(true);
        return;
      }

      // File exists - try to read and parse
      let content = '';
      try {
        content = await invoke<string>('read_yaml_file', { path: filePath });

        // Validate YAML content size
        if (content && content.length > MAX_YAML_SIZE) {
          console.error(`YAML file ${fileName} too large (${content.length} bytes, max ${MAX_YAML_SIZE})`);
          alert(`Error: Configuration file is too large. Using default settings.`);
          setData(defaultData);
          setError(null);
          setLoaded(true);
          return;
        }

        // Validate YAML content before parsing
        if (!content || content.trim().length === 0) {
          console.warn(`YAML file ${fileName} is empty, using defaults`);
          setData(defaultData);
          setError(null);
          setLoaded(true);
          return;
        }

        // Parse with timeout
        const parsed = await Promise.race([
          (async () => {
            return yaml.load(content) as T;
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('YAML parsing timeout')), YAML_PARSE_TIMEOUT)
          )
        ]);

        // Validate parsed data structure
        if (parsed && typeof parsed === 'object') {
          setData(parsed);
          setError(null);
        } else {
          console.warn(`Invalid YAML structure in ${fileName}, using defaults`);
          setData(defaultData);
          setError(null);
        }
      } catch (parseError: unknown) {
        // YAML parsing error - extract detailed error info
        console.error(`Failed to parse ${fileName}:`, parseError);

        // Check if it's a YAMLException with line/column info using type guard
        if (isYAMLException(parseError) && hasMark(parseError)) {
          setError({
            type: 'PARSE_ERROR',
            message: parseError.message || 'Unknown YAML parsing error',
            line: parseError.mark.line + 1, // Convert from 0-indexed to 1-indexed
            column: parseError.mark.column + 1,
            filePath,
            rawContent: content // Reuse already-read content
          });
        } else if (isYAMLException(parseError)) {
          // YAMLException but no mark info
          setError({
            type: 'PARSE_ERROR',
            message: parseError.message || 'Unknown YAML parsing error',
            filePath,
            rawContent: content // Reuse already-read content
          });
        } else {
          // Generic error - still show editor
          const errorMessage = parseError instanceof Error ? parseError.message : 'Unknown error';
          setError({
            type: 'PARSE_ERROR',
            message: errorMessage,
            filePath,
            rawContent: content // Reuse already-read content
          });
        }
        setData(defaultData);
      }
      setLoaded(true);
    } catch (err) {
      console.error(`Failed to load ${fileName}:`, err);
      setData(defaultData);
      setError(null);
      setLoaded(true);
    }
  }, [fileName, defaultData]);

  const saveData = useCallback(async (newData: T) => {
    try {
      const appDataDir = await invoke<string>('get_app_config_dir');
      const filePath = await invoke<string>('join_paths', {
        path1: appDataDir,
        path2: fileName
      });

      await invoke('ensure_directory_exists', { path: appDataDir });

      const yamlContent = yaml.dump(newData, { indent: 2, lineWidth: -1 });

      // Validate size before writing
      if (yamlContent.length > MAX_YAML_SIZE) {
        throw new Error(`Configuration too large (${yamlContent.length} bytes, max ${MAX_YAML_SIZE})`);
      }

      await invoke('write_yaml_file', { path: filePath, content: yamlContent });

      setData(newData);
      setError(null); // Clear error on successful save
    } catch (err) {
      console.error(`Failed to save ${fileName}:`, err);
      throw err;
    }
  }, [fileName]);

  // Reload data (used after fixing errors in editor)
  const reload = useCallback(() => {
    setError(null);
    return loadData();
  }, [loadData]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return { data, saveData, loaded, setData, error, reload };
}
