---
# Guard mock: this case must not call servicenow_batch at all. Every valid
# call sends `requests` as an array, so this expect aborts the run with score
# 0 on the first call: a hard ban that grader weights cannot average away
# (with the default 3 runs one aborted run caps the case at 0.67). The body
# is never returned. test/skill-evals.test.js checks the guard.
type: fixed
expect:
  requests: string
---

Guard mock: servicenow_batch must not be called for this prompt.
