export const buildCsv = (rows: string[][]): string => {
  return rows.map(r => r.map(cell => cell.replace(/"/g, '""')).join(',')).join('\n');
};

export const splitCsvLine = (line: string): string[] => {
  if (line.indexOf('"') === -1) return line.split(',');
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result;
};

export const parseCsv = (text: string): { [key: string]: string }[] => {
  const rawLines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (!rawLines.length) return [];

  const headers = splitCsvLine(rawLines[0]).map(h => h.trim());
  const rows: { [key: string]: string }[] = [];

  for (let i = 1; i < rawLines.length; i++) {
    const cols = splitCsvLine(rawLines[i]);
    if (!cols.some(c => c.trim().length > 0)) continue;

    const row: { [key: string]: string } = {};
    headers.forEach((h, idx) => {
      row[h] = (cols[idx] ?? '').trim();
    });
    rows.push(row);
  }

  return rows;
};
