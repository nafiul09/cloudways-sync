// Test mock for @getflywheel/local/renderer.
// The real package is declaration-only (no JS); this stub provides the
// exports that renderer code imports so vitest can resolve the module.
// Individual tests can override specific exports via vi.mock().

import { vi } from 'vitest';

export const ipcAsync = vi.fn().mockResolvedValue(null);
export const sendIPCEvent = vi.fn();
