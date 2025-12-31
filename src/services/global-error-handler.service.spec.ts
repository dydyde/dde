import { TestBed } from '@angular/core/testing';
import { GlobalErrorHandler, ErrorSeverity } from './global-error-handler.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { Router } from '@angular/router';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('GlobalErrorHandler', () => {
  let service: GlobalErrorHandler;
  let loggerSpy: any;
  let toastSpy: any;
  let routerSpy: any;

  beforeEach(() => {
    loggerSpy = {
      category: vi.fn().mockReturnThis(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    
    toastSpy = {
      error: vi.fn()
    };
    
    routerSpy = {
      navigate: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        GlobalErrorHandler,
        { provide: LoggerService, useValue: loggerSpy },
        { provide: ToastService, useValue: toastSpy },
        { provide: Router, useValue: routerSpy }
      ]
    });

    service = TestBed.inject(GlobalErrorHandler);
    
    // Mock sessionStorage
    const store: {[key: string]: string} = {};
    vi.spyOn(sessionStorage, 'getItem').mockImplementation((key: string) => store[key] || null);
    vi.spyOn(sessionStorage, 'setItem').mockImplementation((key: string, value: string) => store[key] = value + '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should handle chunk load error by reloading page', () => {
    // Mock window.location.reload
    const reloadSpy = vi.fn();
    
    // We need to handle the fact that window.location might be read-only
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    try {
      const error = new Error('Failed to fetch dynamically imported module: https://example.com/chunk.js');
      service.handleError(error);

      expect(reloadSpy).toHaveBeenCalled();
      expect(sessionStorage.setItem).toHaveBeenCalledWith('chunk_load_error_reload_timestamp', expect.any(String));
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });

  it('should not reload if reloaded recently (loop protection)', () => {
    // Mock window.location.reload
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // @ts-ignore
    delete window.location;
    // @ts-ignore
    window.location = { reload: reloadSpy };

    // Mock sessionStorage to return a recent timestamp
    const recentTime = Date.now() - 5000; // 5 seconds ago
    vi.mocked(sessionStorage.getItem).mockReturnValue(recentTime.toString());

    try {
      const error = new Error('ChunkLoadError: Loading chunk 123 failed.');
      service.handleError(error);

      expect(reloadSpy).not.toHaveBeenCalled();
      // Should have logged error and maybe called handleFatalError (which logs error)
      expect(loggerSpy.error).toHaveBeenCalledWith(expect.stringMatching(/Chunk load error persisted/), expect.any(Object));
    } finally {
      // @ts-ignore
      window.location = originalLocation;
    }
  });
});
