import { parseCsv, buildCsv, splitCsvLine } from '../utils/csvHelpers';

export type CsvWorkerRequest =
  | { type: 'parse'; text: string }
  | { type: 'build'; rows: string[][] };

export type CsvWorkerResponse =
  | { type: 'parse'; rows: { [key: string]: string }[] }
  | { type: 'build'; csv: string }
  | { type: 'error'; message: string };

self.onmessage = (e: MessageEvent<CsvWorkerRequest & { _id?: number }>) => {
  try {
    const msg = e.data;
    const _id = msg._id;
    if (msg.type === 'parse') {
      const rows = parseCsv(msg.text);
      (self as any).postMessage({ type: 'parse', rows, _id });
    } else if (msg.type === 'build') {
      const csv = buildCsv(msg.rows);
      (self as any).postMessage({ type: 'build', csv, _id });
    }
  } catch (err: any) {
    (self as any).postMessage({ type: 'error', message: err?.message || String(err), _id: e.data._id });
  }
};
