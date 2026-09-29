"use client";

import React, { useEffect, useRef, useState } from "react";
import { Loader2, TriangleAlert, X } from "lucide-react";

/** Dismissible error message shown at the top of the screen. */
export const ErrorBanner = ({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) => {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] w-[min(92vw,40rem)] bg-red-50 border border-red-200 text-red-800 dark:bg-red-950 dark:border-red-900 dark:text-red-200 rounded-xl shadow-lg p-4 flex gap-3 items-start"
    >
      <TriangleAlert className="w-5 h-5 shrink-0 mt-0.5" aria-hidden />
      <p className="flex-1 text-sm whitespace-pre-line">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900"
        aria-label="Dismiss error"
      >
        <X className="w-4 h-4" aria-hidden />
      </button>
    </div>
  );
};

/** Shows the tail of the model's output while it streams in. */
export const StreamingOutput = ({ text }: { text: string }) => {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  if (!text) return null;
  return (
    <pre
      ref={ref}
      aria-hidden
      className="w-full max-h-64 overflow-auto rounded-lg p-3 text-left text-xs font-mono whitespace-pre-wrap bg-gray-900 text-gray-200"
    >
      {text}
    </pre>
  );
};

/**
 * Status for a long-running request: spinner, message, Cancel, and a hint about
 * sleeping servers if it takes a while.
 */
export const BusyNotice = ({
  message,
  onCancel,
  children,
}: {
  message: string;
  onCancel: () => void;
  children?: React.ReactNode;
}) => {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 w-full" role="status" aria-live="polite">
      <Loader2 className="w-10 h-10 animate-spin text-blue-600" aria-hidden />
      <p className="font-medium text-gray-600 dark:text-gray-200">{message}</p>
      {children}
      {slow && (
        <p className="text-sm text-center max-w-md text-gray-500 dark:text-gray-400">
          Still working… If the server was asleep (free hosting sleeps when idle), it can
          take up to a minute to wake up.
        </p>
      )}
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        Cancel
      </button>
    </div>
  );
};
