/**
 * Every error this package throws. They are all failures — memory never
 * reports a lost write, a decryption problem or a masking leak as a value a
 * caller could ignore (insa-plani §5: no fail-open).
 */

/**
 * The (runId, seq) primary key was taken by a concurrent writer. Thrown by a
 * `JournalStore` implementation, caught by `appendJournal`, which simply
 * re-reads the head and tries the next sequence number.
 */
export class SeqTakenError extends Error {
  constructor(
    readonly runId: string,
    readonly seq: number,
  ) {
    super(`journal seq ${seq} of run ${runId} is already written`);
    this.name = "SeqTakenError";
  }
}

/** The retry budget ran out — a real problem (a stuck store), not a race. */
export class SeqAllocationError extends Error {
  constructor(
    readonly runId: string,
    readonly attempts: number,
  ) {
    super(`could not allocate a journal seq for run ${runId} after ${attempts} attempts`);
    this.name = "SeqAllocationError";
  }
}

/** Session file sealing/opening failed: wrong key, truncated or tampered blob. */
export class SessionCryptoError extends Error {
  constructor(reason: string) {
    // Never echoes key material or ciphertext.
    super(`session file crypto failed: ${reason}`);
    this.name = "SessionCryptoError";
  }
}

/** A caller handed memory something it cannot work with. */
export class MemoryArgumentError extends Error {
  constructor(what: string, reason: string) {
    super(`${what}: ${reason}`);
    this.name = "MemoryArgumentError";
  }
}
