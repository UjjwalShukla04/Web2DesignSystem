"use client";

import React, { useEffect, useId, useState } from "react";
import { Settings } from "lucide-react";
import { cn } from "../lib/cn";
import { fetchUsage, formatCost, type Provider, type UsageSummary } from "../lib/api";
import { FORMATS, FORMAT_KEYS, type OutputFormat } from "../lib/formats";

const PROVIDERS: Provider[] = ["gemini", "openai"];
const PROVIDER_INFO: Record<Provider, { label: string; placeholder: string; getKeyUrl: string }> = {
  gemini: { label: "Gemini", placeholder: "AIza...", getKeyUrl: "https://aistudio.google.com/apikey" },
  openai: { label: "OpenAI", placeholder: "sk-...", getKeyUrl: "https://platform.openai.com/api-keys" },
};

const label = "block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1";
const hint = "text-xs text-gray-500 dark:text-gray-400 mt-1";
const input =
  "w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white border-gray-300 text-gray-900 dark:bg-gray-950 dark:border-gray-700 dark:text-gray-100";
const segmentGroup = "flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg";
const segment = (on: boolean) =>
  cn(
    "flex-1 py-1.5 text-sm font-medium rounded-md transition-all",
    on
      ? "bg-white shadow-sm text-blue-600 dark:bg-gray-700 dark:text-blue-300"
      : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100",
  );

/** One provider's key field, with whether the server already has a key for it. */
const KeyField = ({
  id,
  provider,
  value,
  onChange,
  active,
  serverHasKey,
}: {
  id: string;
  provider: Provider;
  value: string;
  onChange: (value: string) => void;
  active: boolean; // the provider currently selected
  serverHasKey: boolean | null; // null = unknown
}) => {
  const info = PROVIDER_INFO[provider];
  const status = value.trim()
    ? { text: "Using your key.", tone: "text-green-700 dark:text-green-400" }
    : serverHasKey === true
      ? { text: "Optional: the server has a key.", tone: "text-gray-500 dark:text-gray-400" }
      : serverHasKey === false
        ? {
            text: `Needed to use ${info.label}: the server has no working key.`,
            tone: active ? "text-amber-700 dark:text-amber-400" : "text-gray-500 dark:text-gray-400",
          }
        : { text: "Leave empty to use the server's key.", tone: "text-gray-500 dark:text-gray-400" };
  return (
    <div>
      <label htmlFor={id} className={cn(label, "flex items-center justify-between")}>
        <span>
          {info.label} API Key
          {active && (
            <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-600 dark:bg-blue-950 dark:text-blue-300">
              in use
            </span>
          )}
        </span>
        <a
          href={info.getKeyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-normal text-blue-600 hover:underline dark:text-blue-400"
        >
          Get a key
        </a>
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={info.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-status`}
        className={input}
      />
      <p id={`${id}-status`} className={cn("text-xs mt-1", status.tone)}>
        {status.text}
      </p>
    </div>
  );
};

/** Today's usage of the server's key by this user, and the limits. */
const UsageInfo = ({ usage, usingOwnKey }: { usage: UsageSummary | null; usingOwnKey: boolean }) => {
  if (!usage) return null;
  const { limits } = usage;
  return (
    <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
      <p className="font-medium text-gray-700 dark:text-gray-200">Today with the server&apos;s key</p>
      <p className="mt-1">
        {usage.requests} generation{usage.requests === 1 ? "" : "s"}
        {limits.perUserPerDay > 0 && <> of {limits.perUserPerDay}</>} · ~{formatCost(usage.costUsd)}
      </p>
      {usage.budgetExhausted && (
        <p className="mt-1 text-amber-700 dark:text-amber-400">The server&apos;s daily budget is used up.</p>
      )}
      {usingOwnKey && <p className="mt-1">You&apos;re using your own key, so these limits don&apos;t apply.</p>}
    </div>
  );
};

export const ProviderSettings = ({
  provider,
  setProvider,
  keys,
  setKey,
  serverKeys,
  accessCode,
  setAccessCode,
  format,
  setFormat,
  useScreenshots,
  setUseScreenshots,
}: {
  format: OutputFormat;
  setFormat: (f: OutputFormat) => void;
  useScreenshots: boolean;
  setUseScreenshots: (value: boolean) => void;
  provider: Provider;
  setProvider: (p: Provider) => void;
  /** The user's own key per provider ("" = use the server's). */
  keys: Record<Provider, string>;
  setKey: (provider: Provider, key: string) => void;
  /** Whether the server has a key per provider (null = unknown). */
  serverKeys: Record<Provider, boolean> | null;
  accessCode: string;
  setAccessCode: (c: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const id = useId();

  // Close with Escape; load today's usage when opened.
  useEffect(() => {
    if (!isOpen) return;
    fetchUsage().then(setUsage);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    <div className="relative z-50">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-full border shadow-sm transition-colors bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-200 dark:border-gray-700"
        aria-label="AI settings"
        aria-expanded={isOpen}
        aria-controls={`${id}-panel`}
        title="AI Settings"
      >
        <Settings className="w-5 h-5" aria-hidden />
      </button>

      {isOpen && (
        <>
          <div
            id={`${id}-panel`}
            role="dialog"
            aria-label="AI configuration"
            className="fixed inset-x-4 top-20 sm:absolute sm:inset-x-auto sm:right-0 sm:top-12 z-[100] sm:w-80 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl border p-4 shadow-2xl animate-in fade-in zoom-in-95 duration-200 bg-white border-gray-200 text-gray-900 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100"
          >
            <h3 className="font-bold mb-4 flex items-center gap-2">
              <Settings className="w-4 h-4" aria-hidden /> AI Configuration
            </h3>

            <div className="space-y-4">
              <div>
                <span className={label} id={`${id}-format`}>
                  Output
                </span>
                <div className={segmentGroup} role="group" aria-labelledby={`${id}-format`}>
                  {FORMAT_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFormat(key)}
                      aria-pressed={format === key}
                      className={segment(format === key)}
                    >
                      {FORMATS[key].label}
                    </button>
                  ))}
                </div>
                <p className={hint}>Used for the next generation. Everything is styled with Tailwind CSS.</p>
                <label className="mt-3 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                  <input
                    type="checkbox"
                    checked={useScreenshots}
                    onChange={(e) => setUseScreenshots(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-blue-600"
                  />
                  <span>
                    Send screenshots to the AI
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      The original sections, and how your code looks when you ask for a change.
                      Much closer results; uses a few more tokens.
                    </span>
                  </span>
                </label>
              </div>

              <div>
                <span className={label} id={`${id}-provider`}>
                  Provider
                </span>
                <div className={segmentGroup} role="group" aria-labelledby={`${id}-provider`}>
                  {PROVIDERS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setProvider(p)}
                      aria-pressed={provider === p}
                      className={segment(provider === p)}
                    >
                      {PROVIDER_INFO[p].label}
                    </button>
                  ))}
                </div>
              </div>

              {PROVIDERS.map((p) => (
                <KeyField
                  key={p}
                  id={`${id}-key-${p}`}
                  provider={p}
                  value={keys[p]}
                  onChange={(value) => setKey(p, value)}
                  active={provider === p}
                  serverHasKey={serverKeys?.[p] ?? null}
                />
              ))}

              <UsageInfo usage={usage} usingOwnKey={!!keys[provider].trim()} />

              <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                <label htmlFor={`${id}-code`} className={label}>
                  Server Access Code
                </label>
                <input
                  id={`${id}-code`}
                  type="password"
                  autoComplete="off"
                  placeholder="Admin Secret (if required)"
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  className={input}
                />
                <p className={hint}>
                  Required for scraping when the server is protected. With your own API key,
                  generating works without it. Both are kept until you close this tab.
                </p>
              </div>
            </div>
          </div>
          <div className="fixed inset-0 z-[90]" onClick={() => setIsOpen(false)} aria-hidden />
        </>
      )}
    </div>
  );
};
