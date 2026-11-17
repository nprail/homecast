export class DocstoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DocstoreError';
  }
}

/** An insert or update would give two documents the same id or the same value in a unique field. */
export class UniqueViolation extends DocstoreError {
  constructor(message: string) {
    super(message, 'unique');
    this.name = 'UniqueViolation';
  }
}

/** A file failed its checksum somewhere other than the unfinished end of the journal. */
export class CorruptionError extends DocstoreError {
  constructor(message: string) {
    super(message, 'corrupt');
    this.name = 'CorruptionError';
  }
}

/** Another process has the store open. */
export class LockedError extends DocstoreError {
  constructor(message: string) {
    super(message, 'locked');
    this.name = 'LockedError';
  }
}

export class NotFoundError extends DocstoreError {
  constructor(message: string) {
    super(message, 'not_found');
    this.name = 'NotFoundError';
  }
}
