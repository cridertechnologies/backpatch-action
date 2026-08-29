#!/usr/bin/env node
// Entry point for the composite action. Reads the package.json, asks the
// Backpatch API which overrides are now removable, and renders the answer as a
// job summary plus step outputs. Deliberately dependency-free: composite actions
// have no install step, so this runs on the runner's bundled Node and nothing else.

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STATUS = {
  SAFE: 'SafeToRemove',
  STILL_NEEDED: 'StillNeeded',
  NEEDS_MAJOR: 'NeedsMajorUpgrade',
  UNKNOWN: 'Unknown',
}

const LABEL = {
  [STATUS.SAFE]: '✅ Safe to remove',
  [STATUS.STILL_NEEDED]: '🔒 Still needed',
  [STATUS.NEEDS_MAJOR]: '⚠️ Needs major upgrade',
  [STATUS.UNKNOWN]: '❔ Unknown',
}

function input(name, fallback = '') {
  const value = process.env[`BACKPATCH_INPUT_${name}`]
  return value === undefined || value === '' ? fallback : value.trim()
}

function bool(name, fallback = false) {
  const value = input(name)
  return value === '' ? fallback : /^(true|1|yes)$/i.test(value)
}

/** Fails the step with a message GitHub renders as an error annotation. */
function fail(message) {
  console.log(`::error title=Backpatch::${message.replace(/\n/g, ' ')}`)
  process.exit(1)
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return
  // Heredoc form: results is JSON and may contain newlines.
  const delimiter = `__backpatch_${Math.random().toString(36).slice(2)}__`
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

function writeSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    console.log(markdown)
    return
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
}

function readIfPresent(path, { required }) {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (required) {
      fail(
        err.code === 'ENOENT'
          ? `Could not find ${path}. Check the working-directory and package-json inputs.`
          : `Could not read ${path}: ${err.message}`,
      )
    }
    fail(`Could not read the lockfile at ${path}: ${err.message}`)
  }
}

/** Turns a non-2xx API response into an actionable message. */
function describeFailure(status, body) {
  const apiError = body && typeof body.error === 'string' ? body.error : null

  switch (status) {
    case 401:
      return (
        'The Backpatch API rejected the key (401). Every request needs a valid key: check that ' +
        'the api-key input is wired to a secret that is set on this repository, and that the ' +
        'subscription behind it is still active. Get a key at https://backpatch.dev/#pricing.'
      )
    case 402:
      return `${apiError ?? 'Too many overrides for your plan (402).'} See https://backpatch.dev/#pricing.`
    case 413:
      return `${apiError ?? 'The package.json is larger than your plan allows (413).'} See https://backpatch.dev/#pricing.`
    case 429:
      return (
        'Rate limited by the Backpatch API (429). CI runs are bursty and the limit is per key — ' +
        'if this recurs, stagger the workflow or move to a plan with a higher rate limit.'
      )
    default:
      return `The Backpatch API returned ${status}${apiError ? `: ${apiError}` : '.'}`
  }
}

function renderSummary(results, { manifestPath }) {
  const lines = ['## Backpatch — override cleanup', '']

  if (results.length === 0) {
    lines.push(`No overrides, resolutions, or pnpm.overrides found in \`${manifestPath}\`.`)
    return lines.join('\n')
  }

  const removable = results.filter(r => r.status === STATUS.SAFE)
  lines.push(
    removable.length === 0
      ? `Analyzed ${results.length} override${results.length === 1 ? '' : 's'}. None are removable yet.`
      : `**${removable.length} of ${results.length} override${results.length === 1 ? '' : 's'} can be removed.**`,
    '',
    '| Override | Status | Why | Advisory |',
    '| --- | --- | --- | --- |',
  )

  // Removable first — that is the part a reviewer acts on.
  const order = [STATUS.SAFE, STATUS.NEEDS_MAJOR, STATUS.STILL_NEEDED, STATUS.UNKNOWN]
  const sorted = [...results].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  )

  for (const r of sorted) {
    const why = [r.reason, r.suggestedParentUpgrade ? `**${r.suggestedParentUpgrade}**` : null]
      .filter(Boolean)
      .join(' — ')
    lines.push(
      `| \`${r.packageName}@${r.overriddenVersion}\` | ${LABEL[r.status] ?? r.status} | ${escapeCell(why)} | ${
        r.advisoryId ? `\`${r.advisoryId}\`` : '—'
      } |`,
    )
  }

  if (removable.length > 0) {
    lines.push(
      '',
      'Removing an override changes what actually gets installed. Delete the entries, re-resolve ' +
        'the lockfile from scratch, and run your tests before merging.',
    )
  }

  return lines.join('\n')
}

/** Pipes and newlines would break the markdown table. */
function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

async function main() {
  const apiKey = input('API_KEY')
  if (!apiKey) {
    fail(
      'No API key provided. The Backpatch API requires a key on every request — set the api-key ' +
        'input, e.g. api-key: ${{ secrets.BACKPATCH_API_KEY }}.',
    )
  }

  const workingDirectory = input('WORKING_DIRECTORY', '.')
  // Resolve for reading, but report the path the user wrote — the absolute one
  // is a runner temp path that means nothing to them.
  const manifestInput = input('PACKAGE_JSON', 'package.json')
  const manifestPath = resolve(workingDirectory, manifestInput)
  const lockfileInput = input('LOCKFILE')

  const packageJson = readIfPresent(manifestPath, { required: true })
  const lockfileContent = lockfileInput
    ? readIfPresent(resolve(workingDirectory, lockfileInput), { required: false })
    : undefined

  const apiUrl = input('API_URL', 'https://api.backpatch.dev').replace(/\/+$/, '')
  const url = `${apiUrl}/analyze_overrides${bool('ALLOW_MAJOR_BUMP') ? '?allowMajorBump=true' : ''}`

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ packageJson, lockfileContent }),
    })
  } catch (err) {
    fail(`Could not reach the Backpatch API at ${apiUrl}: ${err.message}`)
  }

  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    // Leave payload null; describeFailure falls back to the status code.
  }

  if (!response.ok) fail(describeFailure(response.status, payload))
  if (!Array.isArray(payload)) {
    fail(`The Backpatch API returned an unexpected response shape for ${url}.`)
  }

  const counts = {
    removable: payload.filter(r => r.status === STATUS.SAFE).length,
    needsMajor: payload.filter(r => r.status === STATUS.NEEDS_MAJOR).length,
    stillNeeded: payload.filter(r => r.status === STATUS.STILL_NEEDED).length,
  }

  setOutput('removable-count', String(counts.removable))
  setOutput('needs-major-count', String(counts.needsMajor))
  setOutput('still-needed-count', String(counts.stillNeeded))
  setOutput('total-count', String(payload.length))
  setOutput('results', JSON.stringify(payload))

  const summary = renderSummary(payload, { manifestPath: manifestInput })
  if (bool('SUMMARY', true)) writeSummary(summary)

  console.log(
    `Backpatch: ${payload.length} override(s) analyzed — ${counts.removable} removable, ` +
      `${counts.needsMajor} behind a major upgrade, ${counts.stillNeeded} still needed.`,
  )

  const failOn = input('FAIL_ON', 'never').toLowerCase()
  if (failOn !== 'never' && failOn !== 'removable') {
    fail(`fail-on must be "never" or "removable", got "${failOn}".`)
  }
  if (failOn === 'removable' && counts.removable > 0) {
    fail(
      `${counts.removable} override(s) can be removed. See the job summary for which, and why.`,
    )
  }
}

main().catch(err => fail(err?.stack ?? String(err)))
