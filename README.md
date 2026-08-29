# Backpatch override cleanup — GitHub Action

Reports which `overrides`, `resolutions`, and `pnpm.overrides` entries in your
`package.json` can now be removed, because the parent dependency has since caught
up and pulls in a safe version on its own.

Security fixes leave overrides behind. Nothing in a normal toolchain tells you
when one has stopped doing work — `npm audit` stays quiet precisely *because* the
override is there. This Action asks that question on a schedule, or on the
dependency-bump PRs that are most likely to have made an override redundant.

## Usage

```yaml
name: Override cleanup

on:
  schedule:
    - cron: '0 9 * * 1' # Mondays, 09:00 UTC
  workflow_dispatch:

jobs:
  backpatch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cridertechnologies/backpatch-action@v1
        with:
          api-key: ${{ secrets.BACKPATCH_API_KEY }}
```

The result lands in the job summary. Nothing fails by default — see
[`fail-on`](#inputs) to change that.

### On dependency-bump PRs

The highest-value trigger. A Renovate or Dependabot PR moves a parent
dependency, which is exactly the event that can make an override redundant:

```yaml
on:
  pull_request:
    paths: ['**/package.json', '**/package-lock.json']

jobs:
  backpatch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cridertechnologies/backpatch-action@v1
        with:
          api-key: ${{ secrets.BACKPATCH_API_KEY }}
          lockfile: package-lock.json
```

Passing the lockfile makes the analysis more precise: it reflects what is
actually installed rather than what the ranges allow.

### Acting on the result

`removable-count` and `results` are outputs, so a later step can open an issue,
comment on the PR, or gate a merge:

```yaml
      - uses: cridertechnologies/backpatch-action@v1
        id: backpatch
        with:
          api-key: ${{ secrets.BACKPATCH_API_KEY }}

      - if: steps.backpatch.outputs.removable-count != '0'
        run: |
          echo "${{ steps.backpatch.outputs.removable-count }} override(s) can go."
          echo '${{ steps.backpatch.outputs.results }}' | jq '.[] | select(.status=="SafeToRemove")'
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | *(required)* | Your Backpatch API key. Every request needs one — [start a 14-day trial](https://backpatch.dev/#pricing). Pass it from a secret, never inline. |
| `working-directory` | `.` | Directory the other paths resolve against. Use it for a monorepo package. |
| `package-json` | `package.json` | Manifest to analyze, relative to `working-directory`. |
| `lockfile` | *(none)* | Optional `package-lock.json` or `yarn.lock`. Improves precision. |
| `allow-major-bump` | `false` | Treat overrides that only clear behind a breaking major parent upgrade as removable. Off by default. |
| `fail-on` | `never` | `never` reports only. `removable` fails the job when any override can be removed. |
| `summary` | `true` | Write the results table to the job summary. |
| `api-url` | `https://api.backpatch.dev` | Override only when self-hosting the API. |

## Outputs

| Output | Description |
| --- | --- |
| `removable-count` | Overrides reported `SafeToRemove`. |
| `needs-major-count` | Overrides removable only behind a major parent upgrade. |
| `still-needed-count` | Overrides still doing real work. |
| `total-count` | Override entries analyzed. |
| `results` | The full analysis as a JSON array. |

## Statuses

| Status | Meaning |
| --- | --- |
| `SafeToRemove` | A parent version within reach already pulls in a safe transitive version. |
| `NeedsMajorUpgrade` | Removable, but only behind a breaking major upgrade of a parent. Deliberately **not** `SafeToRemove` — treating it as one produces a PR that deletes an override and breaks the build. |
| `StillNeeded` | No parent has caught up. Keep the override. |
| `Unknown` | The registry or advisory lookup could not settle it. |

## Before you delete anything

The analysis reads declared ranges and registry metadata. It tells you a parent
*should* resolve safely — your lockfile and test suite are what confirm it did.
Delete the entries, re-resolve the lockfile from scratch (`rm -rf node_modules
package-lock.json && npm install`), and run your tests before merging. Updating
in place can leave the old resolution pinned, which makes a still-needed override
look removable.

## Notes

- **What is sent:** your `package.json`, and the lockfile only if you pass one.
  No repository access, no credentials, no source. The API does not retain the
  file beyond the request.
- **Rate limits are per key.** CI is bursty and plan limits are per minute, so a
  busy org on one shared key can rate-limit itself. The Action surfaces a `429`
  with that explanation rather than a bare failure.
- **Requires a key.** There is no anonymous tier. A missing or revoked key fails
  the step with an actionable message.
- **Self-hosting.** If sending a manifest off-network is not an option, point
  `api-url` at your own deployment of the Backpatch API.

## Versioning

Use the floating major tag — `@v1` — to pick up fixes. Pin a full tag or SHA if
you need byte-for-byte reproducibility.

## License

MIT. See [LICENSE](./LICENSE)
