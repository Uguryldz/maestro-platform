import type { StoragePort } from "@maestro/ports";
import { ObjectNotFoundError } from "@maestro/storage";

/** In-memory StoragePort with the same not-found behaviour as the drivers. */
export function fakeStorage(): StoragePort & { readonly objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, data: Uint8Array): Promise<void> {
      objects.set(key, new Uint8Array(data));
    },
    async get(key: string): Promise<Uint8Array> {
      const found = objects.get(key);
      if (found === undefined) throw new ObjectNotFoundError(key);
      return found;
    },
    async list(prefix: string): Promise<string[]> {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
    async presign(): Promise<string> {
      throw new Error("presign is not used by the memory package");
    },
  };
}
