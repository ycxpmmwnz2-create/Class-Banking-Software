import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const indexHtml = readFileSync(join(process.cwd(), "index.html"), "utf8");
const faviconSvg = readFileSync(join(process.cwd(), "public", "favicon.svg"), "utf8");

function embeddedLogoBase64(source) {
  const matches = [...source.matchAll(
    /<img class="center-logo" src="data:image\/webp;base64,([^"]+)" alt="Morgan Bank logo">/g
  )];

  assert.equal(matches.length, 1, "index.html must contain exactly one embedded Morgan Bank logo");
  return matches[0][1];
}

function assertCompleteWebp(base64) {
  assert.match(base64, /^[A-Za-z0-9+/]+={0,2}$/, "logo must contain valid Base64 characters");

  const bytes = Buffer.from(base64, "base64");
  assert.equal(
    bytes.toString("base64"),
    base64,
    "logo Base64 must decode without ignored or malformed input"
  );
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", "logo must be a RIFF file");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", "logo must be a WebP file");
  assert.equal(
    bytes.readUInt32LE(4) + 8,
    bytes.length,
    "logo byte length must match its RIFF header"
  );

  let offset = 12;
  let imageChunkFound = false;
  while (offset < bytes.length) {
    assert.ok(offset + 8 <= bytes.length, "logo must contain a complete WebP chunk header");
    const chunkType = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const paddedChunkEnd = offset + 8 + chunkSize + (chunkSize % 2);
    assert.ok(paddedChunkEnd <= bytes.length, `${chunkType} chunk must not be truncated`);
    imageChunkFound ||= ["VP8 ", "VP8L", "VP8X"].includes(chunkType);
    offset = paddedChunkEnd;
  }

  assert.equal(offset, bytes.length, "logo chunks must consume the complete WebP file");
  assert.equal(imageChunkFound, true, "logo must contain a WebP image chunk");
}

test("embedded Morgan Bank logo is a complete, internally consistent WebP", () => {
  assertCompleteWebp(embeddedLogoBase64(indexHtml));
});

test("logo integrity check rejects the demonstrated two-character data loss", () => {
  const intact = embeddedLogoBase64(indexHtml);
  const historicalRepairPoint = "WhkgUzSdE3";
  assert.ok(intact.includes(historicalRepairPoint), "test fixture must contain the repaired bytes");
  const truncated = intact.replace(historicalRepairPoint, "WhkgSdE3");

  assert.throws(() => assertCompleteWebp(truncated), assert.AssertionError);
});

test("the document links a Morgan Bank favicon instead of the stock Vite mark", () => {
  assert.match(
    indexHtml,
    /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/,
    "index.html must explicitly link the favicon Safari and other browsers should request"
  );
  assert.match(faviconSvg, /<title>Morgan Bank<\/title>/);
  assert.match(faviconSvg, /#12323a/i, "favicon must use the Morgan Bank dark brand color");
  assert.match(faviconSvg, /#5ec7c2/i, "favicon must use the Morgan Bank teal brand color");
  assert.doesNotMatch(
    faviconSvg,
    /#863bff|#7e14ff|#47bfff|vite/i,
    "stock Vite branding must not remain"
  );
});
