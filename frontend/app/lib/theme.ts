"use client";

import { useCallback, useEffect, useState } from "react";
import { THEME_KEY } from "./theme-boot";
import { useMediaQuery } from "./media";

// Light / dark / follow the system. The choice is a per-browser convenience, so it lives
// in localStorage. layout.tsx applies it before the first paint (no flash of the wrong theme).

export type ThemeChoice = "light" | "dark" | "system";

function readChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

/** Current theme choice, the resolved light/dark mode, and a setter. */
export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)"); // follows OS changes live
  const dark = choice === "dark" || (choice === "system" && systemDark);

  // Keep <html> in sync (the class drives every dark: style).
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
    setChoiceState(next);
  }, []);

  return { choice, dark, setChoice };
}
