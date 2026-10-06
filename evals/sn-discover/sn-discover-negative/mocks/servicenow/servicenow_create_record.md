---
# Guard mock: this case must not call servicenow_create_record at all. Every valid
# call sends `table` as a string, so this expect aborts the run with score
# 0 on the first call: a hard ban that grader weights cannot average away
# (with the default 3 runs one aborted run caps the case at 0.67). The body
# is never returned. test/skill-evals.test.js checks the guard.
type: fixed
expect:
  table: number
---

Guard mock: servicenow_create_record must not be called for this prompt.
