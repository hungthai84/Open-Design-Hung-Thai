import type { Express, Response } from 'express';
import {
  PROJECT_CATALOG_CHANGED_EVENT,
  PROJECT_CATALOG_EVENTS_PATH,
  type ProjectCatalogChangedSsePayload,
} from '@open-design/contracts';

type ProjectCatalogSink = (payload: ProjectCatalogChangedSsePayload) => void;

export interface ProjectCatalogEvents {
  subscribe(sink: ProjectCatalogSink): () => void;
  emitChanged(): void;
}

export function createProjectCatalogEvents(
  now: () => number = Date.now,
): ProjectCatalogEvents {
  const sinks = new Set<ProjectCatalogSink>();
  return {
    subscribe(sink) {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
    emitChanged() {
      const payload: ProjectCatalogChangedSsePayload = {
        type: PROJECT_CATALOG_CHANGED_EVENT,
        at: now(),
      };
      for (const sink of Array.from(sinks)) {
        try {
          sink(payload);
        } catch {
          sinks.delete(sink);
        }
      }
    },
  };
}

export interface RegisterProjectCatalogEventsRouteDeps {
  catalogEvents: ProjectCatalogEvents;
  createSseResponse(res: Response): {
    send(event: string, data: unknown): boolean;
  };
}

export function registerProjectCatalogEventsRoute(
  app: Express,
  { catalogEvents, createSseResponse }: RegisterProjectCatalogEventsRouteDeps,
) {
  app.get(PROJECT_CATALOG_EVENTS_PATH, (_req, res) => {
    const sse = createSseResponse(res);
    const unsubscribe = catalogEvents.subscribe((payload) => {
      sse.send(payload.type, payload);
    });
    sse.send('ready', { at: Date.now() });
    res.on('close', unsubscribe);
    res.on('finish', unsubscribe);
  });
}
