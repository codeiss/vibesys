import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAppModeStore } from '@/stores/appMode.store';

describe('appMode store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sessionStorage.clear();
  });

  it('starts with no mode', () => {
    expect(useAppModeStore().mode).toBeNull();
  });

  it('setMode updates state and persists to sessionStorage', () => {
    const store = useAppModeStore();

    store.setMode('graduation');

    expect(store.mode).toBe('graduation');
    expect(sessionStorage.getItem('appMode')).toBe('graduation');
  });

  it('clearMode resets state and removes the persisted value', () => {
    const store = useAppModeStore();
    store.setMode('project');

    store.clearMode();

    expect(store.mode).toBeNull();
    expect(sessionStorage.getItem('appMode')).toBeNull();
  });

  it('restores the mode from sessionStorage on init', () => {
    sessionStorage.setItem('appMode', 'project');

    const store = useAppModeStore();

    expect(store.mode).toBe('project');
  });
});
