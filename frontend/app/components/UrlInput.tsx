"use client";

import React, { useState } from "react";
import { ArrowRight, Globe, Loader2 } from "lucide-react";
import { normalizeUrl } from "../lib/api";
import { BusyNotice } from "./Feedback";

// 1. URL Input
export const UrlInput = ({
  onScrape,
  onInvalid,
  onCancel,
  isLoading,
  toolbar,
}: {
  onScrape: (url: string) => void;
  onInvalid: (message: string) => void;
  onCancel: () => void;
  isLoading: boolean;
  /** History, theme and settings buttons, shown top-right. */
  toolbar: React.ReactNode;
}) => {
  const [url, setUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeUrl(url);
    if (!normalized) {
      onInvalid("Please enter a website address, like example.com or https://example.com.");
      return;
    }
    setUrl(normalized);
    onScrape(normalized);
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 pt-20 pb-10 text-center animate-in fade-in slide-in-from-bottom-4 duration-700 bg-white dark:bg-gray-950">
      <div className="absolute top-4 right-4 flex items-center gap-2">{toolbar}</div>
      <div className="bg-blue-100 dark:bg-blue-950 p-4 rounded-full mb-6">
        <Globe className="w-10 h-10 sm:w-12 sm:h-12 text-blue-600 dark:text-blue-400" aria-hidden />
      </div>
      <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-gray-900 dark:text-white mb-4">
        Turn Websites into <span className="text-blue-600 dark:text-blue-400">Components</span>
      </h1>
      <p className="text-base sm:text-lg text-gray-600 dark:text-gray-300 mb-8 max-w-2xl">
        Paste a URL, select a section, and let AI generate clean, editable
        Tailwind code for React, Vue, Svelte or plain HTML.
      </p>

      <form onSubmit={handleSubmit} className="w-full max-w-lg relative">
        <input
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          aria-label="Website address"
          placeholder="example.com"
          className="w-full pl-5 pr-20 sm:pl-6 py-3.5 sm:py-4 text-base sm:text-lg border-2 rounded-full focus:outline-none focus:border-blue-500 focus:ring-4 transition-all shadow-sm bg-white text-gray-900 border-gray-200 focus:ring-blue-100 placeholder:text-gray-400 dark:bg-gray-900 dark:text-white dark:border-gray-700 dark:focus:ring-blue-900"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={isLoading}
          required
        />
        <button
          type="submit"
          disabled={isLoading}
          aria-label="Find sections"
          className="absolute right-2 top-2 bottom-2 bg-blue-600 hover:bg-blue-700 text-white rounded-full px-5 sm:px-6 flex items-center gap-2 font-medium transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <Loader2 className="animate-spin w-5 h-5" aria-hidden />
          ) : (
            <ArrowRight className="w-5 h-5" aria-hidden />
          )}
        </button>
      </form>
      {isLoading ? (
        <div className="mt-8 w-full max-w-lg">
          <BusyNotice message="Loading the page and finding its sections…" onCancel={onCancel} />
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
          <span>✅ Production Ready</span>
          <span>✅ React · Vue · Svelte · HTML</span>
          <span>✅ Fully Editable</span>
        </div>
      )}
    </div>
  );
};
