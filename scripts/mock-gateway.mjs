// Acceptance helper. Forwards the command-code route to the real gateway, but
// rejects the first POST /responses request exactly the way the gateway does, so
// the plugin's recovery path can be exercised end to end:
//
//   terminal 1: node scripts/mock-gateway.mjs
//   terminal 2: dsh web --patch scripts/acceptance.overlay.yml
//
// The rejection body reproduces the observed two-layer envelope, which is what the
// adapter reads to classify the failure as INVALID_REQUEST.
import { createServer } from 'node:http'

const UPSTREAM = process.env.MOCK_UPSTREAM ?? 'https://api.commandcode.ai'
const PORT = Number(process.env.MOCK_PORT ?? 8791)
const FAILURES = Number(process.env.MOCK_FAILURES ?? 1)

const INNER = `${JSON.stringify({
  type: 'invalid_request_error',
  code: '',
  message: 'invalid request error trace_id: mock',
})}\n`
const REJECTION = JSON.stringify({ message: INNER, type: 'invalid_request_error' })

let rejected = 0
const HOP_BY_HOP = ['host', 'connection', 'content-length', 'transfer-encoding']

const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)

  if (request.method === 'POST' && (request.url ?? '').includes('/responses') && rejected < FAILURES) {
    rejected += 1
    console.log(`[mock] rejected request ${rejected}/${FAILURES}: ${request.url}`)
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(REJECTION)
    return
  }

  const headers = { ...request.headers }
  for (const name of HOP_BY_HOP) delete headers[name]
  const forwarded = await fetch(`${UPSTREAM}${request.url ?? '/'}`, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
  })
  console.log(`[mock] forwarded ${request.method} ${request.url} -> ${forwarded.status}`)
  const responseHeaders = Object.fromEntries(forwarded.headers)
  for (const name of HOP_BY_HOP) delete responseHeaders[name]
  response.writeHead(forwarded.status, responseHeaders)
  if (forwarded.body === null) {
    response.end()
    return
  }
  for await (const chunk of forwarded.body) response.write(chunk)
  response.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`)
  console.log(`[mock] the first ${FAILURES} POST(s) containing /responses are rejected with 400 INVALID_REQUEST`)
})
