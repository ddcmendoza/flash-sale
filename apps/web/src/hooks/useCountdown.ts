import { useEffect, useState } from 'react';

/** Millisecond clock that ticks once per second; drives countdowns. */
export function useCountdown(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}