// Saved projects, kept in the browser's IndexedDB: they survive closing the tab and
// the browser, and stay private to this browser (the app has no user accounts).

import type { OutputFormat } from "./formats";

export interface Project {
  id: string;
  /** e.g. "footer · aetnastudenthealth.com" */
  title: string;
  siteUrl: string;
  kind: "component" | "page";
  format: OutputFormat;
  /** The latest code, including manual edits. */
  code: string;
  /** Screenshots of the original section(s). */
  images: string[];
  fontCss: string;
  fontFamilies: string[];
  /** Estimated AI cost of this project so far (USD). */
  costUsd: number;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = "website-to-component";
const STORE = "projects";
/** Oldest projects beyond this are deleted automatically. */
export const MAX_PROJECTS = 50;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs one request in a transaction and resolves with its result. */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** All projects, most recently updated first. */
export async function listProjects(): Promise<Project[]> {
  const all = await withStore<Project[]>("readonly", (store) => store.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return withStore<Project | undefined>("readonly", (store) => store.get(id));
}

/** Creates or replaces a project, then trims the oldest beyond MAX_PROJECTS. */
export async function saveProject(project: Project): Promise<void> {
  await withStore("readwrite", (store) => store.put(project));
  const all = await listProjects();
  for (const old of all.slice(MAX_PROJECTS)) await deleteProject(old.id);
}

/** Changes some fields of a saved project (no-op if it no longer exists). */
export async function updateProject(id: string, changes: Partial<Project>): Promise<void> {
  const current = await getProject(id);
  if (!current) return;
  await withStore("readwrite", (store) => store.put({ ...current, ...changes, updatedAt: Date.now() }));
}

export async function deleteProject(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

export async function clearProjects(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}

export function newProjectId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
