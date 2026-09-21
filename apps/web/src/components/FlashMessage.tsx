import type { FlashMessageState } from '../hooks/useFlashMessage';

export function FlashMessage({ message }: { message: FlashMessageState | null }) {
  if (!message) return null;
  return (
    <p className={`msg msg-${message.kind}`} role="status">
      {message.text}
    </p>
  );
}