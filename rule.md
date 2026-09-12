# Project Rules

## Do

- Preserve existing behavior when fixing a focused issue.
- Make the smallest change that addresses the reported problem.
- Run a focused validation after every functional change.
- Keep new behavior covered by an existing test or a practical smoke check when possible.
- Read the nearby implementation before changing it.

## Do Not

- Do not touch working features unrelated to the reported issue.
- Do not refactor unrelated files while fixing a focused bug.
- Do not remove existing functionality to hide an error.
- Do not change public APIs, data formats, or persistence behavior without a clear requirement.
- Do not commit changes unless explicitly requested.