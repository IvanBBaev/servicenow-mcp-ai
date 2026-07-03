import test from "node:test";
import assert from "node:assert/strict";

import { jiraBaseUrl, resolveJiraHost } from "../build/core/jira/host.js";

test("appends .atlassian.net to a bare site name", () => {
  assert.equal(jiraBaseUrl("mycompany"), "https://mycompany.atlassian.net");
});

test("accepts a fully qualified atlassian.net site", () => {
  assert.equal(
    jiraBaseUrl("mycompany.atlassian.net"),
    "https://mycompany.atlassian.net",
  );
});

test("strips scheme, path, query and port", () => {
  assert.equal(
    jiraBaseUrl("https://mycompany.atlassian.net:443/jira/software?x=1"),
    "https://mycompany.atlassian.net",
  );
});

test("blocks loopback and internal hosts (SSRF guard)", () => {
  for (const site of [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "http://169.254.169.254/latest/meta-data",
    "foo.local",
    "foo.internal",
    "[::1]",
  ]) {
    assert.throws(() => resolveJiraHost(site), `expected throw for ${site}`);
  }
});

test("rejects embedded credentials", () => {
  assert.throws(
    () => resolveJiraHost("alice@evil.atlassian.net"),
    /embedded credentials/,
  );
  assert.throws(() => resolveJiraHost("https://user:pass@evil.com"));
});

test("rejects an empty or malformed host", () => {
  assert.throws(() => resolveJiraHost(""), /empty or invalid/);
  assert.throws(() => resolveJiraHost("   "), /empty or invalid/);
  assert.throws(() => resolveJiraHost("foo..bar.atlassian.net"));
  assert.throws(() => resolveJiraHost("mycompany.atlassian.net."));
  assert.throws(() => resolveJiraHost("-mycompany.atlassian.net"));
});

test("rejects a non-atlassian.net host without JIRA_ALLOWED_HOSTS", () => {
  const previous = process.env.JIRA_ALLOWED_HOSTS;
  delete process.env.JIRA_ALLOWED_HOSTS;
  try {
    // Canonical Cloud sites still resolve (bare names get the suffix appended).
    assert.equal(resolveJiraHost("mycompany"), "mycompany.atlassian.net");
    // An arbitrary external host is refused — a redirected/typo'd host must not
    // silently receive the API token.
    assert.throws(() => resolveJiraHost("evil.com"), /atlassian\.net/);
    assert.throws(
      () => resolveJiraHost("jira.mycorp.com"),
      /JIRA_ALLOWED_HOSTS/,
    );
    // Look-alike domains must not satisfy the suffix check.
    assert.throws(() => resolveJiraHost("evil-atlassian.net"));
    assert.throws(() => resolveJiraHost("mycompany.atlassian.net.evil.com"));
    // The leading dot matters: the bare apex is not a site.
    assert.throws(() => resolveJiraHost("atlassian.net"), /atlassian\.net/);
  } finally {
    if (previous === undefined) delete process.env.JIRA_ALLOWED_HOSTS;
    else process.env.JIRA_ALLOWED_HOSTS = previous;
  }
});

test("is case-insensitive and whitespace-trimmed", () => {
  assert.equal(
    resolveJiraHost("  MyCompany.ATLASSIAN.net  "),
    "MyCompany.ATLASSIAN.net",
  );
});

test("a Server/Data-Center host is reachable once allow-listed", () => {
  const previous = process.env.JIRA_ALLOWED_HOSTS;
  process.env.JIRA_ALLOWED_HOSTS = "jira.mycorp.com";
  try {
    assert.equal(resolveJiraHost("jira.mycorp.com"), "jira.mycorp.com");
    // A subdomain of the allow-listed suffix is also permitted.
    assert.equal(resolveJiraHost("eu.jira.mycorp.com"), "eu.jira.mycorp.com");
    // Anything outside the allow-list is still refused, even *.atlassian.net.
    assert.throws(
      () => resolveJiraHost("other.atlassian.net"),
      /JIRA_ALLOWED_HOSTS/,
    );
  } finally {
    if (previous === undefined) delete process.env.JIRA_ALLOWED_HOSTS;
    else process.env.JIRA_ALLOWED_HOSTS = previous;
  }
});

test("an allow-listed host that is also internal is still reachable (explicit opt-in)", () => {
  const previous = process.env.JIRA_ALLOWED_HOSTS;
  process.env.JIRA_ALLOWED_HOSTS = "jira.internal";
  try {
    assert.equal(resolveJiraHost("jira.internal"), "jira.internal");
  } finally {
    if (previous === undefined) delete process.env.JIRA_ALLOWED_HOSTS;
    else process.env.JIRA_ALLOWED_HOSTS = previous;
  }
});
