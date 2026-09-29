"use client";

import { useEffect, useState } from "react";

// State kept in sessionStorage survives a page refresh but not closing the tab,
// which is also the right lifetime for the API key and access code.
const PREFIX = "w2c:";

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** useState that is saved to sessionStorage. Must only be used in client-only components. */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readStored(key, initial));
  useEffect(() => {
    try {
      sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage full or disabled: the value just isn't kept across refreshes.
    }
  }, [key, value]);
  return [value, setValue] as const;
}
