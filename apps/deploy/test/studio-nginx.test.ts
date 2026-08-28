import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bankaNginxConfPath, dockerfilePath, ugurdockerNginxConfPath } from "./paths.js";

/**
 * The studio nginx config, checked as data — the webhook gateway in particular.
 *
 * In both production bundles the ONLY published port is studio's nginx; the BFF
 * lives on the compose network and is reachable from outside exclusively
 * through this file. The config once proxied only `/api/` — so Jira's
 * `POST /webhooks/jira` fell through to the SPA fallback and was answered with
 * `index.html`, HTTP 200. Nothing errored, nothing logged, and webhook intake
 * was physically impossible in production while every runbook said it worked
 * (the endpoint itself was fine: apps/bff/src/routes/webhooks.ts).
 *
 * A defect that announces itself as success does not get a second chance to
 * come back silently: these tests pin the `/webhooks/` gateway in both twins.
 */

const bundles = [
  { name: "ugurdocker", path: ugurdockerNginxConfPath() },
  { name: "banka", path: bankaNginxConfPath() },
  // The THIRD copy: deploy/docker/studio-nginx.conf is what Dockerfile.studio
  // bakes into the image itself. The bundles mount their own conf over it, so
  // a stale image copy is invisible in every bundle install — which is exactly
  // how it shipped without the webhook gateway in 1.0.2 and was only caught by
  // inspecting the image, not by any test or install.
  { name: "docker-image", path: dockerfilePath("studio-nginx.conf") },
] as const;

describe.each(bundles)("$name studio-nginx.conf: the webhook gateway", ({ path }) => {
  const conf = readFileSync(path, "utf8");

  it("declares a /webhooks/ location, so deliveries do not fall into the SPA fallback", () => {
    expect(conf).toMatch(/location\s+\/webhooks\/\s*\{/);
  });

  it("proxies it to bff:7001 WITHOUT stripping the prefix", () => {
    /**
     * The BFF serves `/webhooks/jira` from its root, so the path must arrive
     * intact: /webhooks/ → bff:7001/webhooks/. Losing the prefix here is a 404
     * on the BFF — the same silent-dead-endpoint failure with a different
     * status code.
     *
     * The prefix is now preserved by an explicit `rewrite` rather than by
     * `proxy_pass`'s trailing slash, because the upstream travels in a
     * VARIABLE (so nginx re-resolves the container's IP; see the resolver note
     * in the conf). nginx does not rewrite the URI when `proxy_pass` contains
     * a variable, so the rewrite does it in the open.
     */
    expect(conf).toContain("rewrite ^/webhooks/(.*)$ /webhooks/$1 break;");
    expect(conf).toContain("set $bff_webhook http://bff:7001;");
    expect(conf).toContain("proxy_pass         $bff_webhook;");
  });

  it("keeps the /api/ proxy that the panel itself depends on", () => {
    // The webhook gateway was ADDED next to this block; a refactor that merges
    // or renames them must keep both doors open. The `/api/` prefix is stripped
    // by the rewrite (see the webhook test above for why it is not the
    // trailing slash any more).
    expect(conf).toContain("rewrite ^/api/(.*)$ /$1 break;");
    expect(conf).toContain("set $bff_upstream http://bff:7001;");
    expect(conf).toContain("proxy_pass         $bff_upstream;");
  });

  /**
   * The bug this configuration exists to prevent, stated as a test.
   *
   * nginx resolves an upstream NAME once at start-up and keeps that IP for
   * life. On a compose network that means "bff restarted → the panel 502s
   * forever", which is exactly what happened in production: the BFF was
   * updated and the panel went dead until somebody restarted nginx too.
   */
  it("re-resolves the upstream, so a restarted BFF does not 502 the panel", () => {
    expect(conf).toMatch(/resolver\s+127\.0\.0\.11\b/);
    // The `set` must come BEFORE the rewrite: `rewrite ... break` skips the
    // rest of the block, so a later `set` never runs and the variable is empty.
    // Comments are stripped first: they mention `rewrite` by name, and a test
    // that reads prose would fail on an accurate explanation.
    const code = conf
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code.indexOf("set $bff_upstream")).toBeLessThan(
      code.indexOf("rewrite ^/api/"),
    );
  });

  it("contains no directive that rewrites the response/request body", () => {
    // The Jira signature is an HMAC over the RAW bytes
    // (packages/adapter-jira/src/webhook.ts): one changed byte and every
    // delivery is refused as forged. `proxy_pass` forwards the body untouched;
    // sub_filter and friends do not. Anchored to line starts so the config's
    // own "do not add sub_filter here" comment does not trip the check.
    expect(conf).not.toMatch(/^\s*sub_filter/m);
    expect(conf).not.toMatch(/^\s*proxy_set_body/m);
  });
});

describe("studio-nginx.conf: the twins", () => {
  it("ugurdocker and banka carry byte-identical configs", () => {
    // The two bundles are deliberately the same stack distributed two ways
    // (registry pull vs USB stick). The configs share no code, so nothing but
    // this assertion keeps a fix applied to one from silently missing the
    // other — which is exactly how the webhook gap could resurface in a single
    // twin.
    const ugurdocker = readFileSync(ugurdockerNginxConfPath(), "utf8");
    const banka = readFileSync(bankaNginxConfPath(), "utf8");
    expect(ugurdocker).toBe(banka);
  });

  it("the image-embedded conf matches the bundles, comments aside", () => {
    // The image copy carries its own header (it explains the image context, not
    // the bundle's), so byte equality is deliberately NOT required. Everything
    // nginx actually executes must be identical: the bundles OVERWRITE this
    // file via a compose mount, so any functional drift is masked in every
    // bundle install and only surfaces on a bare image — as the missing
    // webhook gateway did in 1.0.2.
    const directivesOnly = (conf: string): string =>
      conf
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trimEnd())
        .filter((line) => line.trim().length > 0)
        .join("\n");
    const image = readFileSync(dockerfilePath("studio-nginx.conf"), "utf8");
    const bundle = readFileSync(ugurdockerNginxConfPath(), "utf8");
    expect(directivesOnly(image)).toBe(directivesOnly(bundle));
  });
});
