import { describe, expect, it } from "vitest";
import { UnexpectedResponseError } from "../src/errors.js";
import {
  decodeXmlText,
  parseErrorCode,
  parseListObjectsV2,
  readTag,
  rootElement,
} from "../src/xml.js";

const CONTEXT = { operation: "list", key: "evidence/2026/", status: 200 };

const TRUNCATED_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>maestro</Name>
  <Prefix>evidence/2026/</Prefix>
  <KeyCount>2</KeyCount>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcx</NextContinuationToken>
  <Contents><Key>evidence/2026/UGURPAY-1/run/a.json</Key><Size>12</Size></Contents>
  <Contents><Key>evidence/2026/UGURPAY-1/run/b &amp; c.json</Key><Size>3</Size></Contents>
</ListBucketResult>`;

const EMPTY_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>maestro</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`;

describe("ListObjectsV2 parsing", () => {
  it("reads keys, the truncation flag and the continuation token", () => {
    expect(parseListObjectsV2(CONTEXT,TRUNCATED_PAGE)).toEqual({
      keys: ["evidence/2026/UGURPAY-1/run/a.json", "evidence/2026/UGURPAY-1/run/b & c.json"],
      isTruncated: true,
      nextContinuationToken: "1ueGcx",
    });
  });

  it("returns an empty, non-truncated page when the bucket has no matches", () => {
    expect(parseListObjectsV2(CONTEXT,EMPTY_PAGE)).toEqual({
      keys: [],
      isTruncated: false,
      nextContinuationToken: undefined,
    });
  });

  it("ignores CommonPrefixes entries, which are not objects", () => {
    const xml =
      `<ListBucketResult><IsTruncated>false</IsTruncated>` +
      `<CommonPrefixes><Prefix>evidence/2025/</Prefix></CommonPrefixes>` +
      `<Contents><Key>evidence/2026/a</Key></Contents></ListBucketResult>`;
    expect(parseListObjectsV2(CONTEXT,xml).keys).toEqual(["evidence/2026/a"]);
  });
});

describe("documents that are not a listing at all", () => {
  it.each([
    ["a proxy login page", "<html><body>authentication required</body></html>"],
    ["an error body", "<Error><Code>AccessDenied</Code></Error>"],
    ["an empty body", ""],
  ])("refuses %s instead of reporting an empty bucket", (_label, body) => {
    expect(() => parseListObjectsV2(CONTEXT, body)).toThrow(UnexpectedResponseError);
  });

  it("names the root element it found", () => {
    expect(rootElement('<?xml version="1.0"?><!DOCTYPE html><html><body>x</body></html>')).toBe(
      "html",
    );
    expect(rootElement('<ListBucketResult xmlns="x">')).toBe("ListBucketResult");
    expect(rootElement("<s3:ListBucketResult>")).toBe("ListBucketResult");
    expect(rootElement("plain text")).toBeUndefined();
  });
});

describe("entity decoding", () => {
  it("decodes named and numeric references", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(decodeXmlText("&#65;&#x42;")).toBe("AB");
  });

  it("leaves an out-of-range numeric reference alone instead of crashing", () => {
    // String.fromCodePoint throws RangeError above U+10FFFF; a hostile or
    // broken gateway must not be able to kill a listing with one entity.
    expect(decodeXmlText("a &#1114112; b")).toBe("a &#1114112; b");
    expect(decodeXmlText("a &#xFFFFFFFF; b")).toBe("a &#xFFFFFFFF; b");
    expect(decodeXmlText("a &#xD800; b")).toBe("a &#xD800; b");
  });

  it("returns undefined for an absent tag rather than an empty string", () => {
    expect(readTag("<a><b>1</b></a>", "c")).toBeUndefined();
    expect(readTag("<a><b></b></a>", "b")).toBe("");
  });

  it("reads a tag that carries attributes", () => {
    expect(readTag('<Key xmlns="x">a/b</Key>', "Key")).toBe("a/b");
  });
});

describe("error bodies", () => {
  it("extracts the S3 error code", () => {
    expect(parseErrorCode("<Error><Code>NoSuchKey</Code><Message>x</Message></Error>")).toBe(
      "NoSuchKey",
    );
  });

  it("returns undefined for a body that is not an S3 error", () => {
    expect(parseErrorCode("<ListBucketResult><Code>x</Code></ListBucketResult>")).toBeUndefined();
    expect(parseErrorCode("plain text gateway failure")).toBeUndefined();
  });
});
