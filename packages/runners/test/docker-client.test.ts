import { describe, expect, it } from "vitest";
import { demultiplex, DockerClient, tail } from "../src/docker-client.js";
import { DockerHttpError, DockerResponseError } from "../src/errors.js";
import { decodeResponse } from "../src/http.js";
import { dockerRoutes, fakeTransport, FIXTURE_CONTAINER_ID, FIXTURES, httpResponse } from "./helpers.js";

function client(handler = dockerRoutes()) {
  const fake = fakeTransport(handler);
  return {
    fake,
    docker: new DockerClient({ transport: fake.transport, apiVersion: "v1.44", requestTimeoutMs: 5_000 }),
  };
}

describe("endpoint shapes (against recorded Engine 29.4 responses)", () => {
  it("pings without a version prefix — /_ping is unversioned", async () => {
    const { docker, fake } = client();

    expect(await docker.ping()).toBe(true);
    expect(fake.requests[0]?.path).toBe("/_ping");
  });

  it("creates a container and returns the daemon's id", async () => {
    const { docker, fake } = client();

    const id = await docker.createContainer("maestro-run-1", { Image: "sha256:abc", Cmd: ["true"] });

    expect(id).toBe(FIXTURE_CONTAINER_ID);
    expect(fake.requests[0]?.path).toBe("/v1.44/containers/create?name=maestro-run-1");
    expect(fake.requests[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toMatchObject({ Image: "sha256:abc" });
  });

  it("reads the exit code out of the chunked wait response", async () => {
    const { docker } = client();

    expect(await docker.waitContainer(FIXTURE_CONTAINER_ID, 60_000)).toBe(7);
  });

  it("gives the wait its own transport budget", async () => {
    const fake = fakeTransport(dockerRoutes());
    const docker = new DockerClient({ transport: fake.transport, apiVersion: "v1.44", requestTimeoutMs: 5_000 });
    const seen: number[] = [];
    const spy = { exchange: (bytes: Uint8Array, options: { timeoutMs: number }) => {
      seen.push(options.timeoutMs);
      return fake.transport.exchange(bytes, options);
    } };
    const withSpy = new DockerClient({ transport: spy, apiVersion: "v1.44", requestTimeoutMs: 5_000 });

    await docker.startContainer("x");
    await withSpy.waitContainer("x", 90_000);

    expect(seen).toEqual([90_000]);
  });

  it("kills with SIGKILL by default and tolerates an already-dead container", async () => {
    const { docker, fake } = client(dockerRoutes({ "/kill": () => FIXTURES.notFound() }));

    await expect(docker.killContainer(FIXTURE_CONTAINER_ID)).resolves.toBeUndefined();
    expect(fake.requests[0]?.path).toContain("signal=SIGKILL");
  });

  it("removes a container with force and keeps its volumes by default", async () => {
    const { docker, fake } = client();

    await docker.removeContainer(FIXTURE_CONTAINER_ID);

    expect(fake.requests[0]?.method).toBe("DELETE");
    expect(fake.requests[0]?.path).toContain("force=true");
    expect(fake.requests[0]?.path).toContain("v=false");
  });

  it("splits the recorded log stream into stdout and stderr", async () => {
    const { docker, fake } = client();

    const logs = await docker.containerLogs(FIXTURE_CONTAINER_ID, 2_000);

    expect(logs.stdout).toBe("hello-stdout\n");
    expect(logs.stderr).toBe("hello-stderr\n");
    expect(fake.requests[0]?.path).toContain("stdout=1&stderr=1&tail=2000");
  });

  it("creates and removes volumes by name", async () => {
    const { docker, fake } = client();

    await docker.createVolume("maestro-cache-npm", { "maestro.layer": "dependency" });
    await docker.removeVolume("maestro-cache-npm", true);

    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toMatchObject({ Name: "maestro-cache-npm", Driver: "local" });
    expect(fake.requests[1]?.path).toBe("/v1.44/volumes/maestro-cache-npm?force=true");
  });

  it("reads the content-addressed id and repo digests of an image", async () => {
    const { docker } = client();

    const image = await docker.inspectImage("postgres:16-alpine");

    expect(image.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(image.repoDigests.every((digest) => digest.includes("@sha256:"))).toBe(true);
  });

  it("percent-encodes ids and names into the path", async () => {
    const { docker, fake } = client();

    await docker.inspectImage("registry/app@sha256:" + "b".repeat(64));

    expect(fake.requests[0]?.path).toContain("registry%2Fapp%40sha256");
  });
});

describe("failure mapping", () => {
  it("turns a non-2xx into a DockerHttpError carrying status, endpoint and daemon message", async () => {
    const { docker } = client(dockerRoutes({ "/start": () => FIXTURES.notFound() }));

    const error = await docker.startContainer("missing").then(() => undefined, (e: unknown) => e as DockerHttpError);

    expect(error).toBeInstanceOf(DockerHttpError);
    expect(error?.status).toBe(404);
    expect(error?.endpoint).toBe("containers/start");
    expect(error?.message).toContain("No such container");
  });

  it("surfaces the real Engine refusal of SecurityOpt seccomp=default", async () => {
    const { docker } = client(dockerRoutes({ "/start": () => FIXTURES.badSeccompStart() }));

    await expect(docker.startContainer("x")).rejects.toThrow(/Decoding seccomp profile failed/);
  });

  it("truncates a huge error body instead of logging it whole", async () => {
    const body = JSON.stringify({ message: "x".repeat(5_000) });
    const { docker } = client(dockerRoutes({ "/start": () => httpResponse(500, body) }));

    const error = await docker.startContainer("x").then(() => undefined, (e: unknown) => e as DockerHttpError);

    expect(error?.message.length).toBeLessThan(400);
    expect(error?.message).toContain("…");
  });

  it("passes a non-JSON error body through as text", async () => {
    const { docker } = client(dockerRoutes({ "/start": () => httpResponse(502, "<html>proxy</html>") }));

    await expect(docker.startContainer("x")).rejects.toThrow(/<html>proxy<\/html>/);
  });

  it("refuses a 2xx whose body is not a JSON object", async () => {
    const { docker } = client(dockerRoutes({ "/containers/create": () => httpResponse(201, "[1,2]") }));

    await expect(docker.createContainer("n", { Image: "i", Cmd: [] })).rejects.toThrow(DockerResponseError);
  });

  it("refuses a wait response without an integer StatusCode — a missing code is not success", async () => {
    const { docker } = client(dockerRoutes({ "/wait": () => httpResponse(200, "{\"Error\":{\"Message\":\"x\"}}") }));

    await expect(docker.waitContainer("x", 1_000)).rejects.toThrow(/StatusCode/);
  });

  it("refuses a create response without an Id", async () => {
    const { docker } = client(dockerRoutes({ "/containers/create": () => httpResponse(201, "{}") }));

    await expect(docker.createContainer("n", { Image: "i", Cmd: [] })).rejects.toThrow(/container Id/);
  });
});

describe("stream demultiplexing", () => {
  it("keeps frame order inside each stream", () => {
    const frame = (stream: number, payload: string): Buffer => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(payload), 4);
      return Buffer.concat([header, Buffer.from(payload, "utf8")]);
    };
    const stream = Buffer.concat([frame(1, "a"), frame(2, "E1"), frame(1, "b"), frame(2, "E2")]);

    expect(demultiplex(stream)).toEqual({ stdout: "ab", stderr: "E1E2" });
  });

  it("returns an empty pair for an empty stream", () => {
    expect(demultiplex(new Uint8Array())).toEqual({ stdout: "", stderr: "" });
  });

  it("falls back to raw text for a TTY stream instead of losing the output", () => {
    const raw = Buffer.from("plain tty output without frames", "utf8");

    expect(demultiplex(raw)).toEqual({ stdout: "plain tty output without frames", stderr: "" });
  });

  it("does not read past the buffer when a frame claims more than it has", () => {
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(999, 4);
    const truncated = Buffer.concat([header, Buffer.from("short", "utf8")]);

    expect(demultiplex(truncated).stdout).toContain("short");
  });

  it("matches what the recorded log fixture contains", () => {
    const body = decodeResponse(FIXTURES.logs()).body;

    expect(demultiplex(body)).toEqual({ stdout: "hello-stdout\n", stderr: "hello-stderr\n" });
  });
});

describe("tail", () => {
  it("keeps the end of the stream, where the failure is", () => {
    expect(tail("abcdefghij", 4)).toBe("ghij");
  });

  it("returns short text unchanged", () => {
    expect(tail("short", 100)).toBe("short");
  });

  it("counts bytes, not characters", () => {
    expect(Buffer.byteLength(tail("ölçüm".repeat(50), 32), "utf8")).toBeLessThanOrEqual(32);
  });
});
