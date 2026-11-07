# Maintenance

`servicenow-mcp-ai` is maintained by one person, [Ivan Baev](https://github.com/IvanBBaev),
in their own time. This page says what you can expect from the project, how to get more
than that, and when the project would stop growing.

## What is maintained

- **Release lines.** The supported versions and how long each line gets fixes are in
  [SECURITY.md](SECURITY.md#supported-versions). Only the latest release of a supported line
  is fixed; there are no backports to older patch releases.
- **ServiceNow releases.** Each new ServiceNow family is checked on a Personal Developer
  Instance once one is available; a REST change that breaks a tool is fixed in the next
  release.
- **Dependencies.** Dependabot proposes updates; a high-severity advisory in a runtime
  dependency blocks the release gate until it is resolved.
- **No telemetry.** The server, the CLI, the VS Code extension and the plugin send nothing
  to the maintainer. Adoption is measured only from public numbers (npm downloads,
  Marketplace installs, stars, issues and discussions), recorded per release in
  [project/KPI.md](project/KPI.md).

## Response expectations

| You send…                                                                                       | What to expect                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A vulnerability report ([SECURITY.md](SECURITY.md))                                             | The response targets in [SECURITY.md](SECURITY.md#response-targets).                                                            |
| A bug report                                                                                    | Best effort. A reproducible bug in the current line is usually triaged within a week, but there is no response-time commitment. |
| A feature request or a [discussion](https://github.com/IvanBBaev/servicenow-mcp-ai/discussions) | Read and answered when time allows. Requests that name a real use case shape the roadmap first.                                 |
| A pull request                                                                                  | Reviewed against [CONTRIBUTING.md](CONTRIBUTING.md); the gate (`npm run check`) must be green.                                  |

## Paid support

For teams that need more than best effort, paid support is available: help setting the
server up on your instances and clients, a policy and profile review for a production
rollout, a drift check wired into your pipeline, or priority work on a tool, prompt or fix
you need. Reach the maintainer through the contact details on the
[GitHub profile](https://github.com/IvanBBaev) or the
[GitHub Sponsors page](https://github.com/sponsors/IvanBBaev). Paid work that changes the
project lands in the public repository under its licence.

Tips through [GitHub Sponsors](https://github.com/sponsors/IvanBBaev) and the other options
in the [README](README.md#support) are welcome and keep the free tier going.

## Park criteria

The project is checked against [project/KPI.md](project/KPI.md) at the 2026-11-19
checkpoint and then once a quarter. It is **parked** when two quarterly checkpoints in a
row (the first possible pair is 2027-02-19 and 2027-05-19) show all of the following:

- no new issue or discussion opened by anyone other than the maintainer since the previous
  checkpoint;
- npm downloads under 500 in the last 30 days;
- no paid-support engagement.

Parked means: no new tools or features; security fixes and breakages caused by a ServiceNow
release are still fixed for the supported lines until the dates in
[SECURITY.md](SECURITY.md#supported-versions); the README says the project is parked. A
parked project is unparked by the same signals going the other way.
