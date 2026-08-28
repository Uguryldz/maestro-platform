import { buildServer } from "@maestro/bff";
import type { FastifyInstance } from "fastify";
import { buildDemoStack, type DemoStack } from "../src/deps.js";

/**
 * The demo stack, built once per suite and injected into rather than listened
 * on. `app.inject` exercises the same routes, guards and handlers a socket
 * would, without binding a port — a test that needed a free port would be a
 * test that fails when somebody is already running the demo.
 *
 * The bcrypt cost is dropped to 4: provisioning seven accounts at the
 * production factor takes minutes and proves nothing extra. The login PATH is
 * untouched, which is the part under test.
 */

export interface DemoHarness extends DemoStack {
  readonly app: FastifyInstance;
  /** Log in and return the bearer token; throws with the body on failure. */
  login(username: string, password: string): Promise<string>;
}

/** A fixed instant, so every seeded stamp is deterministic across runs. */
export const SEEDED_AT = new Date("2026-08-09T09:00:00.000Z");

export async function demoHarness(): Promise<DemoHarness> {
  const stack = await buildDemoStack({
    clock: { now: () => new Date(SEEDED_AT) },
    bcryptRounds: 4,
  });
  const app = await buildServer(stack.deps);

  const login = async (username: string, password: string): Promise<string> => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password },
    });
    if (response.statusCode !== 200) {
      throw new Error(`login failed (${response.statusCode}): ${response.body}`);
    }
    return (response.json() as { token: string }).token;
  };

  return { ...stack, app, login };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
