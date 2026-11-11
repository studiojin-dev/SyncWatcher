import { listen as tauriListen, type EventCallback, type EventName, type Options, type UnlistenFn } from '@tauri-apps/api/event';

export function deferUnlisten(unlisten: UnlistenFn): () => Promise<void> {
  // Tauri queues native listener installation as a separate webview evaluation.
  // IPC can resolve before that evaluation runs; a microtask-only cleanup can
  // therefore look up an event ID that is not installed yet (notably in StrictMode).
  let cleanup: Promise<void> | undefined;
  return () => {
    cleanup ??= new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => unlisten());
    return cleanup;
  };
}

export async function listen<T>(event: EventName, handler: EventCallback<T>, options?: Options): Promise<UnlistenFn> {
  return deferUnlisten(await tauriListen(event, handler, options));
}
