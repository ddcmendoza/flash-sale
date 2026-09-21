import { useCallback, useState } from 'react';

export type FlashMessageKind = 'error' | 'info' | 'success';

export interface FlashMessageState {
  kind: FlashMessageKind;
  text: string;
}

/** Transient inline banner state: one message, cleared by the next action. */
export function useFlashMessage() {
  const [message, setMessage] = useState<FlashMessageState | null>(null);
  const show = useCallback(
    (kind: FlashMessageKind, text: string) => setMessage({ kind, text }),
    [],
  );
  const clear = useCallback(() => setMessage(null), []);
  return { message, show, clear };
}