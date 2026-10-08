// Effectiveness measurement for the auto-continue policy.
//
// Reads the durable session logs and reports, for every automatic continuation it
// finds, whether the session then produced model output and how long that took.
// The same scan reports the raw INVALID_REQUEST turn endings, so the policy can be
// judged against its own baseline.
//
//   node scripts/continue-stats.mjs            # ~/.dsh/sessions
//   node scripts/continue-stats.mjs <root>     # another DSH home's sessions tree
//
// The logs are concatenated Zstandard frames, one per append batch, so the file
// must be split by frame magic before decompressing; a single zstdDecompress call
// returns only the first frame (the session header).
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'

const zstdDecompressAsync = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xfd2fb528
const CONTINUE_KIND = 'auto-continue'
const root = process.argv[2] ?? join(homedir(), '.dsh', 'sessions')

/** Locate complete Zstandard frames in a concatenated stream. */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const remaining = (singleSegment ? 0 : 1)
      + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    if (buffer.length - offset < remaining) return frames
    offset += remaining
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const payload = ((blockHeader >>> 1) & 0x03) === 0x01 ? 1 : blockHeader >>> 3
      if (buffer.length - offset < payload) return frames
      offset += payload
      if ((blockHeader & 1) !== 0) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Decode one session log into its durable events. */
async function readEvents(path) {
  const bytes = readFileSync(path)
  const parts = []
  for (const frame of scanFrames(bytes)) parts.push(await zstdDecompressAsync(bytes.subarray(frame.start, frame.end)))
  const events = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn final line is normal after an interrupted append.
    }
  }
  return events
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.jsonl.zstd')) yield full
  }
}

/** Failure code of one terminal error attempt, when it is a provider failure. */
function attemptCode(event) {
  const failure = (event.data?.stream ?? [])
    .find((part) => part?.chunk?.type === 'finish' && part.chunk.reason?.kind === 'error')
    ?.chunk.reason.failure
  return failure?.code
}

/** Keep the newest recorded generation of each session. */
function newestGeneration(files) {
  const byId = new Map()
  for (const path of files) {
    const id = path.split(/[\\/]/).at(-2) ?? path
    const version = Number(/session\.v(\d+)\.jsonl\.zstd$/.exec(path)?.[1] ?? -1)
    const versionless = Number.isNaN(version) ? -1 : version
    const previous = byId.get(id)
    if (previous === undefined || versionless > previous.version) byId.set(id, { path, version: versionless })
  }
  return [...byId.values()].map((entry) => entry.path)
}

const files = newestGeneration([...walk(root)])
const perDay = new Map()
const rows = []
let rejectedTurnEndings = 0
let rejectedAttempts = 0

for (const path of files) {
  let events
  try {
    events = await readEvents(path)
  } catch {
    continue
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'assistant/attempt' && attemptCode(event) === 'INVALID_REQUEST') rejectedAttempts += 1
    if (event.type === 'turn/end'
      && event.data?.reason?.kind === 'error'
      && event.data.reason.error.code === 'INVALID_REQUEST') {
      rejectedTurnEndings += 1
      continue
    }
    if (event.type !== 'user/message' || event.data?.source?.kind !== CONTINUE_KIND) continue
    const recovery = events.slice(index + 1).find((later) => later.type === 'assistant/message')
    const seconds = typeof recovery?.time === 'number' && typeof event.time === 'number'
      ? Math.round((recovery.time - event.time) / 1000)
      : null
    const day = typeof event.time === 'number' ? new Date(event.time).toISOString().slice(0, 10) : 'unknown'
    const bucket = perDay.get(day) ?? { continues: 0, recovered: 0 }
    bucket.continues += 1
    if (recovery !== undefined) bucket.recovered += 1
    perDay.set(day, bucket)
    rows.push({
      session: path.split(/[\\/]/).at(-2),
      time: typeof event.time === 'number' ? new Date(event.time).toISOString() : 'unknown',
      summary: event.data.source.summary ?? '',
      recovered: recovery !== undefined,
      seconds,
    })
  }
}

const recovered = rows.filter((row) => row.recovered)
const waited = recovered.map((row) => row.seconds).filter((value) => typeof value === 'number').sort((a, b) => a - b)
const median = waited.length === 0 ? null : waited[Math.floor(waited.length / 2)]

console.log(`sessions scanned:        ${files.length}`)
console.log(`INVALID_REQUEST attempts: ${rejectedAttempts}`)
console.log(`INVALID_REQUEST turns:    ${rejectedTurnEndings}`)
console.log(`automatic continuations:  ${rows.length}`)
console.log(`  recovered:              ${recovered.length}${rows.length === 0 ? '' : ` (${Math.round((recovered.length / rows.length) * 100)}%)`}`)
console.log(`  median wait:            ${median === null ? 'n/a' : `${median}s`}`)
console.log('')
console.log('day         continues  recovered  rate')
for (const [day, bucket] of [...perDay.entries()].sort()) {
  const rate = bucket.continues === 0 ? 0 : Math.round((bucket.recovered / bucket.continues) * 100)
  console.log(`${day}  ${String(bucket.continues).padStart(9)}  ${String(bucket.recovered).padStart(9)}  ${String(rate).padStart(3)}%`)
}
if (rows.length > 0) {
  console.log('')
  console.log('last 10 continuations:')
  for (const row of rows.slice(-10)) {
    const waited = row.seconds === null ? '' : ` after ${row.seconds}s`
    console.log(`  ${row.time}  ${row.recovered ? 'recovered' : 'NOT recovered'}${waited}  ${row.summary}`)
  }
}
