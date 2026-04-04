import '@testing-library/jest-dom';
import { vi } from 'vitest';

vi.mock('@tauri-apps/api/app', () => ({
  setTheme: vi.fn(async () => undefined)
}));

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })) as typeof window.matchMedia;
}

if (!globalThis.ResizeObserver) {
  class ResizeObserverMock {
    observe() {
      return;
    }
    unobserve() {
      return;
    }
    disconnect() {
      return;
    }
  }
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
}

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => {
    const context = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'createLinearGradient') {
            return () => ({
              addColorStop: () => undefined
            });
          }
          if (prop === 'measureText') {
            return () => ({ width: 0 });
          }
          if (prop === 'getImageData') {
            return () => ({ data: new Uint8ClampedArray(4) });
          }
          return () => undefined;
        },
        set: () => true
      }
    );
    return context as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
}
