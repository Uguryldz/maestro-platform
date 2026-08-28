import { describe, expect, it } from "vitest";
import {
  amzDate,
  canonicalQueryString,
  canonicalRequest,
  canonicalUri,
  EMPTY_BODY_SHA256,
  presignQuery,
  sha256Hex,
  signingKey,
  signRequest,
  uriEncode,
} from "../src/sigv4.js";
import type { SigningContext } from "../src/sigv4.js";

/**
 * Known-answer vectors published in the AWS Signature Version 4 documentation.
 * They are the only independent oracle available offline, so they are the
 * backbone of this file: if the signer drifts from the spec, these break.
 */
const EXAMPLE_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const s3Context: SigningContext = {
  region: "us-east-1",
  service: "s3",
  credentials: EXAMPLE_CREDENTIALS,
  date: new Date("2013-05-24T00:00:00Z"),
};

describe("signing key derivation", () => {
  it("produces a 32-byte key bound to date, region and service", () => {
    const base = signingKey(EXAMPLE_CREDENTIALS.secretAccessKey, "20130524", "us-east-1", "s3");
    expect(base).toHaveLength(32);
    const others = [
      signingKey(EXAMPLE_CREDENTIALS.secretAccessKey, "20130525", "us-east-1", "s3"),
      signingKey(EXAMPLE_CREDENTIALS.secretAccessKey, "20130524", "eu-west-1", "s3"),
      signingKey(EXAMPLE_CREDENTIALS.secretAccessKey, "20130524", "us-east-1", "iam"),
      signingKey("other-secret", "20130524", "us-east-1", "s3"),
    ];
    for (const other of others) expect(other.toString("hex")).not.toBe(base.toString("hex"));
  });
});

describe("header signing (AWS docs GET Object vector)", () => {
  it("reproduces the published authorization signature", () => {
    const headers = signRequest(s3Context, {
      method: "GET",
      path: "/test.txt",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
      },
      payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("reproduces the published PUT Object signature (encoded '$' in the key)", () => {
    const body = "Welcome to Amazon S3.";
    expect(sha256Hex(body)).toBe(
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    );
    const headers = signRequest(s3Context, {
      method: "PUT",
      path: "/test$file.text",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadSha256: sha256Hex(body),
    });
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("signs the security token when the credentials carry one", () => {
    const headers = signRequest(
      { ...s3Context, credentials: { ...EXAMPLE_CREDENTIALS, sessionToken: "TOKEN" } },
      {
        method: "GET",
        path: "/test.txt",
        headers: { host: "examplebucket.s3.amazonaws.com" },
        payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    );
    expect(headers["x-amz-security-token"]).toBe("TOKEN");
    expect(headers["authorization"]).toContain("x-amz-security-token");
  });
});

describe("query signing (AWS docs presigned URL vector)", () => {
  it("reproduces the published presign signature", () => {
    const query = presignQuery(
      s3Context,
      {
        method: "GET",
        path: "/test.txt",
        headers: { host: "examplebucket.s3.amazonaws.com" },
      },
      86400,
    );
    expect(query["X-Amz-Signature"]).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(query["X-Amz-Credential"]).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(query["X-Amz-SignedHeaders"]).toBe("host");
  });

  it("changes the signature when the expiry changes", () => {
    const base = { method: "GET", path: "/test.txt", headers: { host: "h" } };
    const a = presignQuery(s3Context, base, 60);
    const b = presignQuery(s3Context, base, 61);
    expect(a["X-Amz-Signature"]).not.toBe(b["X-Amz-Signature"]);
  });
});

describe("canonicalisation rules", () => {
  it("percent-encodes the characters encodeURIComponent leaves alone", () => {
    expect(uriEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("encodes path segments once but keeps the separators", () => {
    expect(canonicalUri("/evidence/2026/UGURPAY-1/a b.json")).toBe(
      "/evidence/2026/UGURPAY-1/a%20b.json",
    );
    expect(canonicalUri("/")).toBe("/");
  });

  it("sorts query parameters by encoded name then value", () => {
    expect(canonicalQueryString({ b: "2", a: "1", "a-x": "0" })).toBe("a=1&a-x=0&b=2");
  });

  it("treats header names differing only in case as one header", () => {
    const { text, signedHeaders } = canonicalRequest({
      method: "GET",
      path: "/",
      headers: { Host: "s3.corp.local", host: "s3.corp.local", "X-Amz-Meta-A": " 1  2 " },
      payloadSha256: EMPTY_BODY_SHA256,
    });
    // "host;host" would make every endpoint reject the signature.
    expect(signedHeaders).toBe("host;x-amz-meta-a");
    expect(text).toContain("host:s3.corp.local,s3.corp.local\n");
    expect(text).toContain("x-amz-meta-a:1 2\n");
  });

  it("formats the timestamp as basic ISO 8601", () => {
    expect(amzDate(new Date("2026-08-08T12:34:56.789Z"))).toBe("20260808T123456Z");
  });
});
