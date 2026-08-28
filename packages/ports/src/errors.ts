/** Thrown by drivers for optional capabilities they do not support (M44). */
export class CapabilityNotSupportedError extends Error {
  constructor(
    readonly port: string,
    readonly capability: string,
  ) {
    super(`${port}: capability "${capability}" not supported by this driver`);
    this.name = "CapabilityNotSupportedError";
  }
}
