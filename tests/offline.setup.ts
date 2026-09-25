import { beforeEach, vi } from 'vitest';

// Tests must inject provider fixtures; never fall through to a live sponsor API.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Live fetch is disabled in tests. Inject an HTTP fixture.');
  }));
});
