import test from "node:test";
import assert from "node:assert/strict";

import { _buildBaseUrl } from "../build/servicenow.js";

test("appends .service-now.com to a bare instance name", () => {
  assert.equal(
    _buildBaseUrl("dev12345"),
    "https://dev12345.service-now.com/api/now/table",
  );
});

test("accepts a fully qualified instance host", () => {
  assert.equal(
    _buildBaseUrl("ven03019.service-now.com"),
    "https://ven03019.service-now.com/api/now/table",
  );
});

test("strips scheme, path and port", () => {
  assert.equal(
    _buildBaseUrl("https://ven03019.service-now.com:443/some/path?x=1"),
    "https://ven03019.service-now.com/api/now/table",
  );
});

test("blocks loopback and internal hosts (SSRF guard)", () => {
  for (const instance of [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "http://169.254.169.254/latest/meta-data",
    "foo.local",
    "foo.internal",
  ]) {
    assert.throws(
      () => _buildBaseUrl(instance),
      `expected throw for ${instance}`,
    );
  }
});

test("rejects embedded credentials", () => {
  assert.throws(() => _buildBaseUrl("user:pass@evil.com"));
});

test("honours the SN_ALLOWED_HOSTS allow-list", () => {
  const previous = process.env.SN_ALLOWED_HOSTS;
  process.env.SN_ALLOWED_HOSTS = "service-now.com";
  try {
    assert.equal(
      _buildBaseUrl("ven03019.service-now.com"),
      "https://ven03019.service-now.com/api/now/table",
    );
    assert.throws(() => _buildBaseUrl("evil.com"));
  } finally {
    if (previous === undefined) delete process.env.SN_ALLOWED_HOSTS;
    else process.env.SN_ALLOWED_HOSTS = previous;
  }
});
