"use client";

import { useSyncExternalStore } from "react";

const matches = (query: string) => typeof window !== "undefined" && window.matchMedia(query).matches;

/** True while the media query matches (e.g. "(max-width: 767px)" for phones). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => matches(query),
    // The app renders only in the browser, but React still uses this "server" value
    // during its first (hydration) render. Returning the real value avoids flipping
    // layouts right after mounting — which remounted Sandpack's preview on phones and
    // left its loading overlay stuck over the finished preview.
    () => matches(query),
  );
}

/** Phones and small tablets: the editor switches to one pane at a time. */
export const MOBILE_QUERY = "(max-width: 767px)";
