import { describe, it, expect } from 'vitest';
import { CHANNELS, PING_CHANNEL } from '../../src/shared/ipcTypes';

describe('ipc channel constants', () => {
  it('exposes the ping channel for Phase 0 smoke', () => {
    expect(PING_CHANNEL).toBe('cs:ping');
  });

  it('namespaces every channel under cs:', () => {
    for (const channel of Object.values(CHANNELS)) {
      expect(channel).toMatch(/^cs:/);
    }
  });
});
