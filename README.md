Chain-of-Trust Verification
===========================

![Cot](https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Cot_%28PSF%29.png/640px-Cot_%28PSF%29.png)

This is still a work in progress hack, feel free to play with the idea.

Basic concept:
 * Define a set of rules in `rules.js`
 * Construct a proof-tree using rules
 * Display proof-tree as a JSON structure

Rather than verifying all tasks in a push, this is done in a bottom-up approach
we start with a `taskId` and a desired artifact. Then we download the artifact
verify it against it against the COT artifact from task. Then we proceed to
verify all dependent tasks as necessary, following all the way up to the decision task.

To do this we have two concepts in `rules.js`:
 * **Source extractors** takes a task and attempts to determine the
   project/revision that it origins from.
 * **Rules** takes a task and a project/revision and answers if the task is a
   result of the given project/revision.

Rules are built as a set of conditions, a condition is a function that
given `(ProofBuilder, cot, source)` returns a `Reason` object or throws a
`ProofError`. If all conditions in a rule returns a `Reason` object, then
the rule, source and `Reason` objects forms a proof-tree.

A rule to check if a task is valid decision for given project/revision would check:
 * `taskId` is equal to `taskGroupId`
 * Task definition matches a valid paramterization of `.taskcluster.yml`

A rule to check if a task is a valid docker-worker task for a given project/revision would check:
 * All dependent tasks are valid for given project/revision
 * The image task is valid for some project/revision (this is where source extractors are used)

The idea is to put all the logic to fetch artifacts and recursively validate
dependent tasks into `ProofBuilder`, this way we can ensure that rules don't
end up with cyclic correctness dependencies.
