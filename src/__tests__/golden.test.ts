import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { appendPiEvents } from '../append.js'
import { createTranslationContext, parsePiJsonlStream } from '../ingest.js'

const rawFixturePath = fileURLToPath(
  new URL('./fixtures/pi-subagent-lineage-sanitized.jsonl', import.meta.url),
)
const goldenFixturePath = fileURLToPath(
  new URL('./fixtures/dsh-session-golden.jsonl', import.meta.url),
)
const goldenShaPath = fileURLToPath(
  new URL('./fixtures/GOLDEN.sha256', import.meta.url),
)

describe('Golden Fixture Producer Guard', () => {
  it('generates the authentic DSH session stream from real Pi raw events and matches golden fixture', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'))
    let uuidCounter = 1
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
    )

    const rawJsonl = readFileSync(rawFixturePath, 'utf8')
    const translated = parsePiJsonlStream(rawJsonl, createTranslationContext(0))
    const session = Session.create('sess-lineage-001' as SessionId)
    appendPiEvents(session, translated)

    // Append canonical Track B control intervention receipt via Session.append
    session.append('control/intervention', {
      verb: 'abort',
      targetSessionId: 'sess-lineage-001',
      operator: 'sab',
      reason: 'canary intervention verification',
      timestamp: '2026-03-01T12:00:05.000Z',
      outcome: 'success',
      details: { note: 'verified fail-closed receipt' },
    })

    const serializedLines = session.events.map(ev => JSON.stringify(ev) + '\n')
    const fullContent = serializedLines.join('')

    if (process.env['REGEN'] === '1') {
      writeFileSync(goldenFixturePath, fullContent, 'utf8')
      const hash = createHash('sha256').update(fullContent).digest('hex')
      writeFileSync(goldenShaPath, `${hash}  dsh-session-golden.jsonl\n`, 'utf8')
    }

    const existing = readFileSync(goldenFixturePath, 'utf8')
    expect(fullContent).toBe(existing)

    const currentHash = createHash('sha256').update(fullContent).digest('hex')
    const existingShaFile = readFileSync(goldenShaPath, 'utf8')
    expect(existingShaFile).toContain(currentHash)
  })
})
