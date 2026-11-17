import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { CorruptionError } from './errors.js';

/**
 * The on-disk format is one record per line: an 8-digit checksum, a space, then the record.
 *
 *   P <collection> <json>     store this document (insert or replace)
 *   D <collection> <json id>  delete the document with this id
 *   B / E                     begin / end of a group that must apply all together or not at all
 *
 * Snapshots and journals use the same format, so a snapshot followed by journals is just a longer file. JSON never
 * contains a raw newline, so a line is a record, and a half-written last line is easy to spot.
 */
export const encode = (record: string): string => `${crc32(record).toString(16).padStart(8, '0')} ${record}\n`;

export interface ReadResult {
  records: number;
  /** Bytes up to the end of the last good record. */
  validBytes: number;
  /** The file ended in a partial or damaged record (only allowed with `tolerateTail`). */
  truncated: boolean;
}

/**
 * Read every record of a file in chunks, so a database larger than a string can hold still loads.
 * With `tolerateTail`, a bad or unfinished last record is reported instead of thrown: that is what a crash in the
 * middle of a write leaves behind. A bad record anywhere else is damage and always throws.
 */
export function readLog(file: string, onRecord: (record: string, offset: number) => void, opts: { tolerateTail: boolean }): ReadResult {
  const fd = openSync(file, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    let buf = Buffer.allocUnsafe(1 << 22);
    let have = 0; // bytes in buf
    let base = 0; // file offset of buf[0]
    let records = 0;
    let valid = 0;
    let eof = false;
    while (!eof || have > 0) {
      if (!eof) {
        if (have === buf.length) {
          // A single record bigger than the buffer: grow it.
          const bigger = Buffer.allocUnsafe(buf.length * 2);
          buf.copy(bigger, 0, 0, have);
          buf = bigger;
        }
        const n = readSync(fd, buf, have, buf.length - have, null);
        if (n === 0) eof = true;
        have += n;
      }
      let pos = 0;
      const view = buf.subarray(0, have);
      for (;;) {
        const nl = view.indexOf(10, pos);
        if (nl === -1) break;
        const lineEnd = base + nl + 1;
        const ok = nl - pos > 9 && view[pos + 8] === 32 && crc32(view.subarray(pos + 9, nl)) === parseInt(view.toString('latin1', pos, pos + 8), 16);
        if (!ok) {
          if (opts.tolerateTail && lineEnd >= fileSize) return { records, validBytes: valid, truncated: true };
          throw new CorruptionError(`${file}: damaged record at byte ${base + pos}`);
        }
        onRecord(view.toString('utf8', pos + 9, nl), base + pos);
        records++;
        valid = lineEnd;
        pos = nl + 1;
      }
      // Whatever is left has no newline yet.
      buf.copy(buf, 0, pos, have);
      base += pos;
      have -= pos;
      if (eof) {
        if (have > 0) {
          if (opts.tolerateTail) return { records, validBytes: valid, truncated: true };
          throw new CorruptionError(`${file}: unfinished record at byte ${base}`);
        }
        break;
      }
    }
    return { records, validBytes: valid, truncated: false };
  } finally {
    closeSync(fd);
  }
}
