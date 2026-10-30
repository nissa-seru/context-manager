/**
 * A message removed from inside a summary's sources, under KnowledgeStrategy:
 * the summary keeps its place over the messages that remain (#321), so a
 * merge over it and the store's next open both hold (context-manager D34).
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, KnowledgeStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '../src/types/index.js';

const STORE = './test-knowledge-removed-source';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };

const text = (s: string): ContentBlock => ({ type: 'text', text: s });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

interface Summary { id: string; level: number; sourceIds: string[]; content: unknown }
interface Inside { summaries: Summary[] }

function stub() {
  let calls = 0;
  const membrane = {
    complete: async () => {
      calls++;
      return { stopReason: 'end_turn', content: [text(`a recollection ${calls}, of what was weighed and decided`)], usage: { input_tokens: 100, output_tokens: 20 } };
    },
  };
  return { membrane, calls: () => calls };
}

function knowledge(): KnowledgeStrategy {
  return new KnowledgeStrategy({
    compressionModel: 'test-compression-model',
    headWindowTokens: 0,
    recentWindowTokens: 0,
    mergeThreshold: 3,
    summaryTargetTokens: 20,
    autoTickOnNewMessage: false,
  } as ConstructorParameters<typeof KnowledgeStrategy>[0]);
}

async function open(strategy: KnowledgeStrategy, membrane: object, viewFilter?: (m: StoredMessage) => boolean) {
  return ContextManager.open({ path: STORE, strategy, membrane: membrane as never, ...(viewFilter ? { viewFilter } : {}) });
}

const drain = async (m: ContextManager) => { for (let i = 0; i < 30; i++) { await m.tick(); await settle(); } };

/** Three messages, each with its own marker, then the drain: one chunk, one L1 over them. */
async function triple(m: ContextManager, name: string): Promise<string[]> {
  const ids = [0, 1, 2].map((k) =>
    m.addMessage(k % 2 === 0 ? 'User' : 'Claude', [text(`${name}-${k} we weighed the evidence and drew a conclusion about it `.repeat(4))]));
  await drain(m);
  return ids;
}

const summaries = (s: KnowledgeStrategy) => (s as unknown as Inside).summaries;
const l1Over = (s: KnowledgeStrategy, id: string) => summaries(s).find((x) => x.level === 1 && x.sourceIds.includes(id));
const l2Over = (s: KnowledgeStrategy, l1: string) => summaries(s).find((x) => x.level === 2 && x.sourceIds.includes(l1));

describe('KnowledgeStrategy: a message removed from inside a summary\'s sources', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('a merge taken after the removal leaves a store that opens again, its load audit finding nothing', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    const l1b = l1Over(s, b[1])?.id;
    assert.ok(l1b, 'B has its L1');
    m.removeMessage(b[1]);
    await triple(m, 'C');
    assert.ok(l2Over(s, l1b), 'the merge takes the L1 the removed message was under');
    m.close();

    const again = knowledge();
    const reopened = await open(again, membrane);
    assert.deepEqual(again.getTopologyViolations(), []);
    reopened.close();
  });

  it('a removal under a summary already merged leaves a store that opens again, its load audit finding nothing', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    await triple(m, 'C');
    const l1b = l1Over(s, b[1])?.id;
    assert.ok(l1b && l2Over(s, l1b), 'B\'s L1 is merged');
    m.removeMessage(b[1]);
    m.close();

    const again = knowledge();
    const reopened = await open(again, membrane);
    assert.deepEqual(again.getTopologyViolations(), []);
    reopened.close();
  });

  it('after the removal, the summary still stands for the messages that remain: they go out inside it, not raw, and aren\'t summarized again', async () => {
    const { membrane, calls } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    m.removeMessage(b[1]);
    const before = calls();
    await drain(m);
    assert.equal(calls(), before, 'no call summarizes B\'s remaining messages again');
    const out = await m.compile({ maxTokens: 100_000, reserveForResponse: 0 });
    const sent = JSON.stringify(out.messages);
    assert.ok(!sent.includes('B-0 we weighed') && !sent.includes('B-2 we weighed'), 'B\'s remaining messages aren\'t sent raw');
    m.close();
  });

  it('a summary whose sources are all removed is left out of merges, and the store opens again, its load audit finding nothing', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    for (const id of b) m.removeMessage(id);
    await triple(m, 'C');
    await triple(m, 'D');
    const l1b = l1Over(s, b[1])?.id;
    assert.ok(l1b, 'B\'s L1 stands');
    assert.equal(l2Over(s, l1b), undefined, 'no merge takes it');
    m.close();

    const again = knowledge();
    const reopened = await open(again, membrane);
    assert.deepEqual(again.getTopologyViolations(), []);
    reopened.close();
  });

  it('of two summaries over the same messages, one of them removed, the one listed first stands for the rest', async () => {
    const { membrane } = stub();
    class Twice extends KnowledgeStrategy {
      add(entry: { id: string; level: number; sourceLevel: number; sourceIds: string[]; sourceRange: { first: string; last: string }; content: string; tokens: number; created: number }): void {
        this.pushSummary(entry as never);
      }
    }
    const s = new Twice({
      compressionModel: 'test-compression-model', headWindowTokens: 0, recentWindowTokens: 0,
      summaryTargetTokens: 20, autoTickOnNewMessage: false,
    } as ConstructorParameters<typeof KnowledgeStrategy>[0]);
    const m = await open(s, membrane);
    const ids = [0, 1, 2].map((k) => m.addMessage(k % 2 === 0 ? 'User' : 'Claude', [text(`T-${k} we weighed the evidence and drew a conclusion about it `.repeat(4))]));
    for (const name of ['FIRST', 'SECOND']) {
      s.add({ id: `L1-${name.toLowerCase()}`, level: 1, sourceLevel: 0, sourceIds: ids, sourceRange: { first: ids[0], last: ids[2] }, content: `${name}-RECOLLECTION`, tokens: 10, created: 0 });
    }
    m.removeMessage(ids[1]);
    const out = JSON.stringify((await m.compile({ maxTokens: 100_000, reserveForResponse: 0 })).messages);
    assert.ok(out.includes('FIRST-RECOLLECTION'), 'the first summary goes out');
    assert.ok(!out.includes('SECOND-RECOLLECTION'), 'the second doesn\'t');
    assert.ok(!out.includes('T-0 we weighed') && !out.includes('T-2 we weighed'), 'the messages it stands for aren\'t sent raw');
    m.close();
  });

  it('a message a view filter hides from inside a merged summary\'s sources counts as gone: the store opens, its load audit finding nothing', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    await triple(m, 'C');
    assert.ok(l2Over(s, l1Over(s, b[1])!.id), 'B\'s L1 is merged');
    m.close();

    const hidden = b[1];
    const again = knowledge();
    const reopened = await open(again, membrane, (msg) => msg.id !== hidden);
    assert.deepEqual(again.getTopologyViolations(), []);
    reopened.close();
  });
});
