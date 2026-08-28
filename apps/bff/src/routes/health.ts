import type { FastifyInstance } from "fastify";
import type { ResolvedDeps } from "../deps.js";

/**
 * Liveness and readiness. Unauthenticated on purpose: a container probe has no
 * credentials, and neither endpoint reveals anything a caller could not learn
 * by watching the port. They carry no run data, no ticket keys and no counts
 * that identify work — only whether this process can serve.
 */
export async function healthRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  app.get("/healthz", async (_request, reply) => {
    // The environment name comes from the validated config (M6), so an
    // operator can tell at a glance which deployment answered.
    return reply.code(200).send({ status: "ok", env: deps.config.env.NODE_ENV });
  });

  /**
   * Readiness answers "would a request work right now", which means actually
   * touching the two dependencies every write path needs: the workflow engine
   * and the kill-switch state. A readiness probe that only proves the process
   * is up is how a dead deployment stays in the load balancer.
   */
  app.get("/readyz", async (_request, reply) => {
    const checks: Record<string, "ok" | "fail"> = {};
    try {
      await deps.runs.ping();
      checks["workflows"] = "ok";
    } catch {
      checks["workflows"] = "fail";
    }
    try {
      await deps.killSwitch.get();
      checks["killswitch"] = "ok";
    } catch {
      checks["killswitch"] = "fail";
    }

    const ready = Object.values(checks).every((value) => value === "ok");
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "degraded", checks });
  });
}
