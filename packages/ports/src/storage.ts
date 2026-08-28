/** Storage port (K67 BYOS): s3-compat and pg-blob drivers. */
export interface StoragePort {
  put(key: string, data: Uint8Array, opts?: { contentType?: string; objectLock?: boolean }): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  /** Presigned/short-lived read URL; drivers without URL support throw CapabilityNotSupportedError. */
  presign(key: string, ttlSeconds: number): Promise<string>;
}
