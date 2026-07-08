/**
 * Persistence layer for saved assessments.
 *
 * MVP: localStorage as JSON. The app only ever talks to the `AssessmentStore`
 * interface, so a Supabase (or any remote) implementation can be swapped in
 * later by changing the export at the bottom of this file — no refactoring of
 * components required. Methods are async for that reason even though the
 * localStorage implementation is synchronous underneath.
 */

import type { SavedAssessment } from "./types";

export interface AssessmentStore {
  list(): Promise<SavedAssessment[]>;
  get(id: string): Promise<SavedAssessment | null>;
  /** Insert or update (matched by id). */
  save(assessment: SavedAssessment): Promise<void>;
  remove(id: string): Promise<void>;
}

const STORAGE_KEY = "splaycheck.assessments.v1";

class LocalStorageStore implements AssessmentStore {
  private read(): SavedAssessment[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SavedAssessment[]) : [];
    } catch {
      return [];
    }
  }

  private write(items: SavedAssessment[]): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  async list(): Promise<SavedAssessment[]> {
    return this.read().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<SavedAssessment | null> {
    return this.read().find((a) => a.id === id) ?? null;
  }

  async save(assessment: SavedAssessment): Promise<void> {
    const items = this.read();
    const idx = items.findIndex((a) => a.id === assessment.id);
    if (idx >= 0) items[idx] = assessment;
    else items.push(assessment);
    this.write(items);
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((a) => a.id !== id));
  }
}

/** Swap this for a SupabaseStore later without touching the components. */
export const assessmentStore: AssessmentStore = new LocalStorageStore();

export function newAssessmentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
