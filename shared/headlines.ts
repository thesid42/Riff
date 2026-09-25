import { z } from 'zod';

export const HEADLINE_MAX_LENGTH = 60;
export const LEGACY_HEADLINE_MAX_LENGTH = 120;

export function countHeadlineCharacters(text: string): number {
  return Array.from(text.trim()).length;
}

export function isValidHeadlineSet(values: string[]): boolean {
  return isHeadlineSet(values, HEADLINE_MAX_LENGTH, true);
}

/** Accepts the historical 120 UTF-16-code-unit limit for restoring old waves. */
export function isStoredHeadlineSet(values: string[]): boolean {
  return isHeadlineSet(values, LEGACY_HEADLINE_MAX_LENGTH, false);
}

function isHeadlineSet(values: string[], maxLength: number, rejectControls: boolean): boolean {
  if (values.length < 2 || values.length > 3) return false;
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || (rejectControls && /[\p{Cc}\uFFFD]/u.test(trimmed))) return false;
    const length = rejectControls ? Array.from(trimmed).length : trimmed.length;
    if (length > maxLength) return false;
    normalized.push(trimmed.toLocaleLowerCase());
  }
  return new Set(normalized).size === normalized.length;
}

export const headlineSetSchema = z.array(z.string().trim()).min(2).max(3)
  .refine(isValidHeadlineSet, `Headlines must be 2 or 3 unique, non-empty lines of up to ${HEADLINE_MAX_LENGTH} characters, without control or replacement characters.`);
