// The one text rule of an artifact embedding (src/db/artifacts.ts). The live write path and the PostgreSQL re-embed both
// take their text from artifactEmbeddingText, so these cells pin the rule itself: title and meta, blank parts dropped,
// one space between the rest.
import { describe, expect, it } from 'vitest'
import { artifactEmbeddingText } from '../db/artifacts.js'

describe('artifactEmbeddingText: the title and the meta, the blank parts dropped, joined by one space', () => {
  it('joins a title and a meta with one space', () => {
    expect(artifactEmbeddingText('Quarterly plan', '{"kind":"plan"}')).toBe('Quarterly plan {"kind":"plan"}')
  })

  it('drops a blank title and keeps the meta alone', () => {
    expect(artifactEmbeddingText('   ', '{"a":1}')).toBe('{"a":1}')
    expect(artifactEmbeddingText('', '{"a":1}')).toBe('{"a":1}')
  })

  it('drops a blank meta and keeps the title alone', () => {
    expect(artifactEmbeddingText('Title', '  ')).toBe('Title')
  })

  it('is empty when both parts are blank (the write path then writes no embedding)', () => {
    expect(artifactEmbeddingText(' ', '')).toBe('')
  })
})
