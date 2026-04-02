import { useRef, useCallback } from 'react';
import type { CsvWorkerRequest, CsvWorkerResponse } from '../workers/csvWorker';

let workerInstance: Worker | null = null;
let pendingId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('../workers/csvWorker.ts', import.meta.url), { type: 'module' });
    workerInstance.onmessage = (e: MessageEvent<CsvWorkerResponse & { _id?: number }>) => {
      const id = e.data._id;
      if (id != null && pending.has(id)) {
        const { resolve, reject } = pending.get(id)!;
        pending.delete(id);
        if (e.data.type === 'error') {
          reject(new Error((e.data as any).message));
        } else {
          resolve(e.data);
        }
      }
    };
  }
  return workerInstance;
}

function postToWorker<T extends CsvWorkerResponse>(msg: CsvWorkerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++pendingId;
    pending.set(id, { resolve, reject });
    const worker = getWorker();
    worker.postMessage({ ...msg, _id: id });
  });
}

export function useCsvWorker() {
  const parseCsvAsync = useCallback(async (text: string): Promise<{ [key: string]: string }[]> => {
    try {
      const result = await postToWorker<CsvWorkerResponse & { type: 'parse'; rows: any[] }>({
        type: 'parse',
        text,
      });
      return result.rows;
    } catch {
      // Fallback to main thread if worker fails
      const { parseCsv } = await import('../utils/csvHelpers');
      return parseCsv(text);
    }
  }, []);

  const buildCsvAsync = useCallback(async (rows: string[][]): Promise<string> => {
    try {
      const result = await postToWorker<CsvWorkerResponse & { type: 'build'; csv: string }>({
        type: 'build',
        rows,
      });
      return result.csv;
    } catch {
      const { buildCsv } = await import('../utils/csvHelpers');
      return buildCsv(rows);
    }
  }, []);

  return { parseCsvAsync, buildCsvAsync };
}
