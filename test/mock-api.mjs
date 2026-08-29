// Minimal stand-in for the Backpatch API so CI can exercise the action end to
// end without a real key. Modes are selected with MOCK_MODE.
import { createServer } from 'node:http'

const mode = process.env.MOCK_MODE ?? 'ok'
const port = Number(process.env.PORT ?? 4599)

const RESULTS = [
  {
    packageName: 'tough-cookie',
    overriddenVersion: '4.1.3',
    status: 'SafeToRemove',
    suggestedParentUpgrade: 'upgrade request to 2.89.0',
    advisoryId: 'GHSA-72xf-g2v4-qvf3',
    reason: 'request@2.89.0 already ships tough-cookie@4.1.4',
  },
  {
    packageName: 'qs',
    overriddenVersion: '6.11.0',
    status: 'StillNeeded',
    suggestedParentUpgrade: null,
    advisoryId: 'GHSA-hrpp-h998-j3pp',
    reason: 'the newest express@4.x still resolves qs@6.10.3',
  },
]

createServer((req, res) => {
  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', () => {
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (!req.headers['x-api-key']) return json(401, { error: 'An API key is required.' })
    if (mode === 'unauthorized') return json(401, { error: 'Invalid or revoked API key.' })
    if (mode === 'ratelimit') { res.writeHead(429); return res.end('') }
    if (mode === 'empty') return json(200, [])

    // The real API accepts the manifest as a string under packageJson.
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return json(400, { error: 'body was not JSON' })
    }
    if (typeof parsed.packageJson !== 'string') {
      return json(400, { error: 'packageJson must be sent as a string' })
    }

    json(200, RESULTS)
  })
}).listen(port, () => console.log(`mock backpatch api on :${port} (${mode})`))
