export const buildCsv = (rows: string[][]): string => {
  const escapeCell = (cell: string): string => {
    const value = cell ?? '';
    if (/[",\r\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };
  return rows.map(r => r.map(escapeCell).join(',')).join('\n');
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

/** Reassemble physical lines into logical CSV rows, respecting quoted newlines. */
const assembleLogicalLines = (text: string): string[] => {
  const physicalLines = text.split(/\r?\n/);
  const logical: string[] = [];
  let buffer = '';
  let insideQuotes = false;

  for (const line of physicalLines) {
    if (buffer) {
      buffer += '\n' + line;
    } else {
      buffer = line;
    }
    // Count unescaped quotes to determine if we're still inside a quoted field
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') insideQuotes = !insideQuotes;
    }
    if (!insideQuotes) {
      if (buffer.trim().length > 0) logical.push(buffer);
      buffer = '';
    }
  }
  // flush last buffer
  if (buffer.trim().length > 0) logical.push(buffer);
  return logical;
};

export const parseCsv = (text: string): { [key: string]: string }[] => {
  const rawLines = assembleLogicalLines(text);
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

/** Detect delimiter from the first line (supports comma, tab, semicolon). */
export const detectDelimiter = (firstLine: string): string => {
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  if (tabCount >= commaCount && tabCount >= semiCount && tabCount > 0) return '\t';
  if (semiCount > commaCount && semiCount > 0) return ';';
  return ',';
};

/** Split a line by an arbitrary single-char delimiter, respecting quoted fields. */
export const splitDelimitedLine = (line: string, delimiter: string): string[] => {
  if (delimiter === ',' ) return splitCsvLine(line);
  if (line.indexOf('"') === -1) return line.split(delimiter);
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
};

/** Parse CSV/TSV text with auto-detected delimiter. */
export const parseDelimited = (text: string): { [key: string]: string }[] => {
  const rawLines = assembleLogicalLines(text);
  if (!rawLines.length) return [];
  const delimiter = detectDelimiter(rawLines[0]);

  const headers = splitDelimitedLine(rawLines[0], delimiter).map(h => h.trim());
  const rows: { [key: string]: string }[] = [];
  for (let i = 1; i < rawLines.length; i++) {
    const cols = splitDelimitedLine(rawLines[i], delimiter);
    if (!cols.some(c => c.trim().length > 0)) continue;
    const row: { [key: string]: string } = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] ?? '').trim(); });
    rows.push(row);
  }
  return rows;
};
