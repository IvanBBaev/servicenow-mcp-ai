---
# Recorded by test/evals/record-mocks.js from the real server against
# the fake instance (test/evals/fake-instance.js). Do not edit by hand:
# run `npm run eval:mocks` after a tool's output changes.
type: fixed
---

{"kind":"syslog","window_minutes":1440,"available":true,"level":"warning","by_level":{"error":1,"warning":1},"top_sources":[{"source":"EscalationUtil","count":1},{"source":"Escalate P1 incidents","count":1}],"count":2,"truncated":false,"rows":[{"created_on":"2026-10-01 09:20:00","level":"error","source":"EscalationUtil","created_by":"","message":"TypeError: Cannot read property \"member\" of undefined (sys_script_include.EscalationUtil; line 8)"},{"created_on":"2026-10-01 09:20:00","level":"warning","source":"Escalate P1 incidents","created_by":"","message":"Escalation skipped: no on-call rota for Network"}],"table":"syslog","caveats":["Time windows are evaluated by the instance (javascript:gs.minutesAgoStart); counts come from the Aggregate API, rows are capped by `limit`.","syslog rows are read without a total count (sysparm_no_count) to keep the query cheap on a large log table."]}
