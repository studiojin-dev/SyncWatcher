import { useState, useEffect, useCallback } from 'react';
import * as yaml from 'js-yaml';
import { invoke } from '@tauri-apps/api/core';

interface YamlStoreOptions<T> {
  fileName: string;
  defaultData: T;
}

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
        const parsed = yaml.load(content) as T;
        setData(parsed);
      } catch {
        console.warn(`Failed to load ${fileName}, using defaults:`);
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
