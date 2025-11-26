declare module '@angular/service-worker' {
  import { Observable } from 'rxjs';

  export interface VersionReadyEvent {
    type: 'VERSION_READY';
  }

  export abstract class SwUpdate {
    abstract readonly isEnabled: boolean;
    abstract readonly versionUpdates: Observable<VersionReadyEvent>;
  }

  export function provideServiceWorker(script: string, options?: any): any;
}
