/**
 * Driver registry (M44 clean-room DI): the core never imports a driver
 * module; drivers register factories, the composition root resolves them.
 */
export type DriverFactory<P> = (config: unknown) => P;

export class PortRegistry {
  private readonly ports = new Map<string, Map<string, DriverFactory<unknown>>>();

  register<P>(port: string, driver: string, factory: DriverFactory<P>): void {
    const drivers = this.ports.get(port) ?? new Map<string, DriverFactory<unknown>>();
    if (drivers.has(driver)) {
      throw new Error(`duplicate driver "${driver}" for port "${port}"`);
    }
    drivers.set(driver, factory as DriverFactory<unknown>);
    this.ports.set(port, drivers);
  }

  resolve<P>(port: string, driver: string): DriverFactory<P> {
    const drivers = this.ports.get(port);
    const factory = drivers?.get(driver);
    if (!factory) {
      const available = drivers ? [...drivers.keys()].join(", ") : "(none)";
      throw new Error(`no driver "${driver}" for port "${port}" — available: ${available}`);
    }
    return factory as DriverFactory<P>;
  }

  drivers(port: string): string[] {
    return [...(this.ports.get(port)?.keys() ?? [])];
  }
}
