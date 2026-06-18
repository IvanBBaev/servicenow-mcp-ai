import test from "node:test";
import assert from "node:assert/strict";

import { _buildBaseUrl } from "../build/api/table.js";

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

test("rejects a non-service-now.com host without SN_ALLOWED_HOSTS (SEC-8)", () => {
  const previous = process.env.SN_ALLOWED_HOSTS;
  delete process.env.SN_ALLOWED_HOSTS;
  try {
    // Canonical instances still resolve (bare names get the suffix appended).
    assert.equal(
      _buildBaseUrl("dev12345"),
      "https://dev12345.service-now.com/api/now/table",
    );
    // An arbitrary external host is refused — a redirected/typo'd host must not
    // silently receive Basic credentials.
    assert.throws(() => _buildBaseUrl("evil.com"), /service-now\.com/);
    assert.throws(() => _buildBaseUrl("api.example.com"), /SN_ALLOWED_HOSTS/);
    // Look-alike domains must not satisfy the suffix check.
    assert.throws(() => _buildBaseUrl("evil-service-now.com"));
    assert.throws(() => _buildBaseUrl("foo.service-now.com.evil.com"));
    // The leading dot matters: the bare apex is not an instance.
    assert.throws(() => _buildBaseUrl("service-now.com"), /service-now\.com/);
    // The suffix check is case-insensitive and whitespace-trimmed.
    assert.equal(
      _buildBaseUrl("DEV12345.SERVICE-NOW.COM"),
      "https://DEV12345.SERVICE-NOW.COM/api/now/table",
    );
    assert.equal(
      _buildBaseUrl("  dev12345.service-now.com  "),
      "https://dev12345.service-now.com/api/now/table",
    );
    // A trailing-dot FQDN is rejected as a malformed host.
    assert.throws(() => _buildBaseUrl("dev12345.service-now.com."));
  } finally {
    if (previous === undefined) delete process.env.SN_ALLOWED_HOSTS;
    else process.env.SN_ALLOWED_HOSTS = previous;
  }
});

test("a custom domain is reachable once allow-listed (SEC-8 opt-in)", () => {
  const previous = process.env.SN_ALLOWED_HOSTS;
  process.env.SN_ALLOWED_HOSTS = "mycorp.example.com";
  try {
    assert.equal(
      _buildBaseUrl("mycorp.example.com"),
      "https://mycorp.example.com/api/now/table",
    );
  } finally {
    if (previous === undefined) delete process.env.SN_ALLOWED_HOSTS;
    else process.env.SN_ALLOWED_HOSTS = previous;
  }
});
