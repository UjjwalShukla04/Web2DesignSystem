"use client";

import React, { useEffect, useState } from "react";
import { History, Trash2, X } from "lucide-react";
import { formatCost } from "../lib/api";
import { FORMATS } from "../lib/formats";
import { clearProjects, deleteProject, listProjects, MAX_PROJECTS, type Project } from "../lib/history";

/** Button that opens the history drawer. */
export const HistoryButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="p-2 rounded-full border shadow-sm transition-colors bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-200 dark:border-gray-700"
    aria-label="History: your saved components"
    title="History"
  >
    <History className="w-5 h-5" aria-hidden />
  </button>
);

function when(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Drawer listing saved projects (kept in this browser). */
export const HistoryPanel = ({
  open,
  onClose,
  onOpenProject,
  currentProjectId,
}: {
  open: boolean;
  onClose: () => void;
  onOpenProject: (project: Project) => void;
  currentProjectId: string | null;
}) => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listProjects()
      .then((list) => !cancelled && setProjects(list))
      .catch(() => !cancelled && setError("Your browser's storage isn't available, so history can't be shown."));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const remove = async (id: string) => {
    await deleteProject(id);
    setProjects((list) => list?.filter((p) => p.id !== id) ?? null);
  };
  const removeAll = async () => {
    if (!window.confirm("Delete all saved projects from this browser?")) return;
    await clearProjects();
    setProjects([]);
  };

  return (
    <div className="fixed inset-0 z-[150] flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label="History"
        className="relative flex h-full w-full sm:w-[28rem] flex-col bg-white text-gray-900 shadow-2xl dark:bg-gray-900 dark:text-gray-100"
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-800">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <History className="h-5 w-5" aria-hidden /> History
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Saved in this browser only · last {MAX_PROJECTS} kept
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label="Close history"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {!error && projects === null && <p className="text-sm text-gray-500">Loading…</p>}
          {projects?.length === 0 && (
            <p className="mt-8 text-center text-sm text-gray-500 dark:text-gray-400">
              Nothing yet. Every component or page you generate is saved here automatically.
            </p>
          )}
          <ul className="space-y-3">
            {projects?.map((project) => (
              <li
                key={project.id}
                className={
                  "flex gap-3 rounded-xl border p-3 " +
                  (project.id === currentProjectId
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                    : "border-gray-200 dark:border-gray-800")
                }
              >
                <button
                  type="button"
                  onClick={() => onOpenProject(project)}
                  className="flex min-w-0 flex-1 gap-3 text-left"
                  aria-label={`Open ${project.title}`}
                >
                  <div className="h-16 w-24 shrink-0 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
                    {project.images[0] && (
                      // eslint-disable-next-line @next/next/no-img-element -- a local data URL
                      <img src={project.images[0]} alt="" className="h-full w-full object-cover object-top" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{project.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                        {FORMATS[project.format].label}
                      </span>
                      {project.kind === "page" && <span>Page</span>}
                      <span>{when(project.updatedAt)}</span>
                      {project.costUsd > 0 && <span>· ~{formatCost(project.costUsd)}</span>}
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => remove(project.id)}
                  className="self-start rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/50"
                  aria-label={`Delete ${project.title}`}
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>

        {!!projects?.length && (
          <footer className="border-t border-gray-200 p-3 text-right dark:border-gray-800">
            <button type="button" onClick={removeAll} className="text-sm text-red-600 hover:underline dark:text-red-400">
              Delete all
            </button>
          </footer>
        )}
      </aside>
    </div>
  );
};
