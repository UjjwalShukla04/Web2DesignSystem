"use client";

import React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemeChoice } from "../lib/theme";

const NEXT: Record<ThemeChoice, ThemeChoice> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "System" };

/** Cycles light → dark → system. */
export const ThemeToggle = ({
  choice,
  onChange,
}: {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}) => {
  const Icon = choice === "light" ? Sun : choice === "dark" ? Moon : Monitor;
  return (
    <button
      type="button"
      onClick={() => onChange(NEXT[choice])}
      className="p-2 rounded-full border shadow-sm transition-colors bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-200 dark:border-gray-700"
      aria-label={`Theme: ${LABEL[choice]} (switch to ${LABEL[NEXT[choice]]})`}
      title={`Theme: ${LABEL[choice]} — click for ${LABEL[NEXT[choice]]}`}
    >
      <Icon className="w-5 h-5" aria-hidden />
    </button>
  );
};
