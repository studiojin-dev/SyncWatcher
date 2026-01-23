import { useState, useEffect, useCallback } from 'react';
import * as yaml from 'js-yaml';
import { invoke } from '@tauri-apps/api/core';

interface YamlStoreOptions<T> {
  fileName: string;
  defaultData: T;
}

// Maximum YAML file size (1MB) for security
const MAX_YAML_SIZE = 1024 * 1024;

// Timeout for YAML parsing (5 seconds)
const YAML_PARSE_TIMEOUT = 5000;

export function useYamlStore<T extends Record<string, any>>({
  fileName,
  defaultData,
}: YamlStoreOptions<T>) {
  const [data, setData] = useState<T>(defaultData);
  const [loaded, setLoaded] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const appDataDir = await invoke<string>('get_app_config_dir');
      const filePath = await invoke<string>('join_paths', {
        path1: appDataDir,
        path2: fileName
      });

      try {
        const content = await invoke<string>('read_yaml_file', { path: filePath });

        // Validate YAML content size
        if (content && content.length > MAX_YAML_SIZE) {
          console.error(`YAML file ${fileName} too large (${content.length} bytes, max ${MAX_YAML_SIZE})`);
          alert(`Error: Configuration file is too large. Using default settings.`);
          setData(defaultData);
          setLoaded(true);
          return;
        }

        // Validate YAML content before parsing
        if (!content || content.trim().length === 0) {
          console.warn(`YAML file ${fileName} is empty, using defaults`);
          setData(defaultData);
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
        } else {
          console.warn(`Invalid YAML structure in ${fileName}, using defaults`);
          setData(defaultData);
        }
      } catch (parseError) {
        // File doesn't exist or is corrupted - create it with default data
        console.warn(`Could not read ${fileName}, creating with defaults`);
        await invoke('ensure_directory_exists', { path: appDataDir });
        const yamlContent = yaml.dump(defaultData, { indent: 2, lineWidth: -1 });
        await invoke('write_yaml_file', { path: filePath, content: yamlContent });
        setData(defaultData);
      }
      setLoaded(true);
    } catch (err) {
      console.error(`Failed to load ${fileName}:`, err);
      setData(defaultData);
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
    } catch (err) {
      console.error(`Failed to save ${fileName}:`, err);
      throw err;
    }
  }, [fileName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return { data, saveData, loaded, setData };
}
