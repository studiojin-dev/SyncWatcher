import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import tauriConfig from '../../src-tauri/tauri.conf.json';

export const DEFAULT_APP_VERSION = tauriConfig.version;

export function useAppVersion() {
  const [appVersion, setAppVersion] = useState(DEFAULT_APP_VERSION);

  useEffect(() => {
    let cancelled = false;

    getVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        console.warn('Failed to get app version from Tauri app API; using tauri.conf.json version');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return appVersion;
}
