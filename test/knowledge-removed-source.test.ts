/**
 * A message removed from inside a summary's sources, hidden by a view filter
 * or pinned raw, under KnowledgeStrategy: the summary keeps its place over the
 * messages that remain (#321), so a merge over it and the store's next open
 * both hold.
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

const options = {
  compressionModel: 'test-compression-model',
  headWindowTokens: 0,
  recentWindowTokens: 0,
  summaryTargetTokens: 20,
  autoTickOnNewMessage: false,
};

function knowledge(): KnowledgeStrategy {
  return new KnowledgeStrategy({ ...options, mergeThreshold: 3 } as ConstructorParameters<typeof KnowledgeStrategy>[0]);
}

/** A KnowledgeStrategy whose summaries a test writes itself. */
class Seeded extends KnowledgeStrategy {
  l1(id: string, sourceIds: string[]): void {
    this.pushSummary({
      id, level: 1, sourceLevel: 0, sourceIds, sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
      content: `${id} recollection`, tokens: 10, created: 0,
    } as never);
  }
  l2(id: string, sources: string[], first: string, last: string): void {
    this.pushSummary({
      id, level: 2, sourceLevel: 1, sourceIds: sources, sourceRange: { first, last },
      content: `${id} recollection`, tokens: 10, created: 0,
    } as never);
    for (const source of sources) {
      this.setMergedInto((this as unknown as Inside).summaries.find((x) => x.id === source) as never, id);
    }
  }
}

const seeded = () => new Seeded(options as ConstructorParameters<typeof KnowledgeStrategy>[0]);

async function open(strategy: KnowledgeStrategy, membrane: object, viewFilter?: (m: StoredMessage) => boolean) {
  return ContextManager.open({ path: STORE, strategy, membrane: membrane as never, ...(viewFilter ? { viewFilter } : {}) });
}

async function reopenFindsNothing(membrane: object, viewFilter?: (m: StoredMessage) => boolean): Promise<ContextManager> {
  const again = knowledge();
  const reopened = await open(again, membrane, viewFilter);
  assert.deepEqual(again.getTopologyViolations(), []);
  return reopened;
}

const drain = async (m: ContextManager) => { for (let i = 0; i < 30; i++) { await m.tick(); await settle(); } };
const say = (m: ContextManager, who: string, body: string) =>
  m.addMessage(who, [text(`${body} we weighed the evidence and drew a conclusion about it `.repeat(4))]);
const call = (m: ContextManager, id: string) =>
  m.addMessage('Claude', [text('looking it up'), { type: 'tool_use', id, name: 'mcpl:search', input: { q: id } } as never]);
const result = (m: ContextManager, id: string) =>
  m.addMessage('User', [{ type: 'tool_result', toolUseId: id, content: `found ${id} `.repeat(30) } as never]);
const TOOLS = [{ name: 'mcpl:search', description: 'search', inputSchema: { type: 'object' as const } }];

async function triple(m: ContextManager, name: string): Promise<string[]> {
  const ids = [0, 1, 2].map((k) => say(m, k % 2 === 0 ? 'User' : 'Claude', `${name}-${k}`));
  await drain(m);
  return ids;
}

const summaries = (s: KnowledgeStrategy) => (s as unknown as Inside).summaries;
const l1Over = (s: KnowledgeStrategy, id: string) => summaries(s).find((x) => x.level === 1 && x.sourceIds.includes(id));
const l2Over = (s: KnowledgeStrategy, l1: string) => summaries(s).find((x) => x.level === 2 && x.sourceIds.includes(l1));
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : (content as { type: string; text?: string }[]).find((b) => b.type === 'text')?.text ?? '';
const sentRaw = (sent: string, marker: string) => sent.includes(`${marker} we weighed`);
const linkOf = (s: KnowledgeStrategy, id: string) =>
  (s as unknown as { chunks: { messages: { id: string }[]; summaryId?: string }[] }).chunks
    .find((c) => c.messages.some((x) => x.id === id))?.summaryId;
const compileAll = async (m: ContextManager) => JSON.stringify((await m.compile({ maxTokens: 100_000, reserveForResponse: 0 })).messages);

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
    (await reopenFindsNothing(membrane)).close();
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
    (await reopenFindsNothing(membrane)).close();
  });

  for (const how of ['removed', 'hidden by a view filter'] as const) {
    it(`a tool call ${how} from inside a merged summary, its result staying, leaves a store that opens again, its load audit finding nothing`, async () => {
      const { membrane } = stub();
      const s = knowledge();
      const m = await open(s, membrane);
      m.setToolDefinitions(TOOLS);
      await triple(m, 'A');
      const d = say(m, 'User', 'D');
      const c1 = call(m, 't1');
      result(m, 't1');
      call(m, 't2');
      result(m, 't2');
      await drain(m);
      await triple(m, 'C');
      const l1 = l1Over(s, d)?.id;
      assert.ok(l1 && l2Over(s, l1) && l1Over(s, c1)?.id === l1, 'one L1 over the dialogue, both calls and their results, merged');
      if (how === 'removed') m.removeMessage(c1);
      m.close();
      const reopened = await reopenFindsNothing(membrane, how === 'removed' ? undefined : (msg) => msg.id !== c1);
      assert.ok(!sentRaw(await compileAll(reopened), 'D'), 'the dialogue the summary holds isn\'t sent raw');
      reopened.close();
    });
  }

  it('a source of a merged summary pinned raw leaves a store that opens again, its load audit finding nothing', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    await triple(m, 'C');
    assert.ok(l2Over(s, l1Over(s, b[1])!.id), 'B\'s L1 is merged');
    m.pinRange(b[1], b[1]);
    m.close();
    (await reopenFindsNothing(membrane)).close();
  });

  it('after the removal, the summary still stands for the messages that remain: it goes out, they don\'t go out raw, and they aren\'t summarized again', async () => {
    const { membrane, calls } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    const l1b = l1Over(s, b[1]);
    assert.ok(l1b, 'B has its L1');
    m.removeMessage(b[1]);
    const before = calls();
    await compileAll(m);
    await drain(m);
    assert.equal(calls(), before, 'no call summarizes B\'s remaining messages again');
    const sent = await compileAll(m);
    assert.ok(sent.includes(textOf(l1b.content)), 'B\'s L1 goes out');
    assert.ok(!sentRaw(sent, 'B-0') && !sentRaw(sent, 'B-2'), 'B\'s remaining messages aren\'t sent raw');
    m.close();
  });

  it('after the removal and a merge, a switch to an earlier branch and back re-initializes, and the branch takes messages again', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    const a = await triple(m, 'A');
    const b = await triple(m, 'B');
    m.removeMessage(b[1]);
    await triple(m, 'C');
    assert.ok(l2Over(s, l1Over(s, b[0])!.id), 'the merge takes the L1 the removed message was under');
    const from = m.currentBranch().name;
    const back = m.branchAt(a[2], 'before-b');
    await m.switchBranch(back);
    await m.switchBranch(from);
    assert.deepEqual(s.getTopologyViolations(), []);
    assert.ok(m.addMessage('User', [text('after the switch')]), 'the branch takes a message');
    m.close();
  });

  it('a summary whose sources are all removed is left out of the merge that follows, and the store opens again, its load audit finding nothing', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    const l1b = l1Over(s, b[1])?.id;
    assert.ok(l1b, 'B has its L1');
    for (const id of b) m.removeMessage(id);
    await triple(m, 'C');
    await triple(m, 'D');
    assert.ok(summaries(s).some((x) => x.level === 2), 'a merge follows the removal');
    assert.equal(l2Over(s, l1b), undefined, 'no merge takes B\'s L1');
    m.close();
    (await reopenFindsNothing(membrane)).close();
  });

  for (const built of ['first', 'second'] as const) {
    it(`of two L1s over the same messages, the one an L2 is built on (the ${built} listed) keeps the ones left after a removal, so the store opens again`, async () => {
      const { membrane } = stub();
      const s = seeded();
      const m = await open(s, membrane);
      const ids = Array.from({ length: 9 }, (_, k) => say(m, k % 2 === 0 ? 'User' : 'Claude', `S-${k}`));
      s.l1('L1-a', ids.slice(0, 3));
      s.l1('L1-first', ids.slice(3, 6));
      s.l1('L1-second', ids.slice(3, 6));
      s.l1('L1-c', ids.slice(6, 9));
      s.l2('L2-x', ['L1-a', `L1-${built}`, 'L1-c'], ids[0], ids[8]);
      m.removeMessage(ids[4]);
      m.close();
      (await reopenFindsNothing(membrane)).close();
    });
  }

  for (const held of ['neither', 'both'] as const) {
    it(`of two L1s over the same messages, ${held} held by an L2, the first listed keeps the ones left after a removal`, async () => {
      const { membrane } = stub();
      const s = seeded();
      const m = await open(s, membrane);
      const ids = Array.from({ length: 6 }, (_, k) => say(m, k % 2 === 0 ? 'User' : 'Claude', `S-${k}`));
      s.l1('L1-a', ids.slice(0, 3));
      s.l1('L1-first', ids.slice(3, 6));
      s.l1('L1-second', ids.slice(3, 6));
      if (held === 'both') {
        s.l2('L2-x', ['L1-a', 'L1-first'], ids[0], ids[5]);
        s.l2('L2-y', ['L1-second'], ids[3], ids[5]);
      }
      m.removeMessage(ids[4]);
      m.close();
      const again = knowledge();
      const reopened = await open(again, membrane);
      assert.equal(linkOf(again, ids[3]), 'L1-first');
      reopened.close();
    });
  }

  it('once an L2 takes the second of two L1s over the same messages, the next rebuild links the second', async () => {
    const { membrane } = stub();
    const s = seeded();
    const m = await open(s, membrane);
    const ids = Array.from({ length: 6 }, (_, k) => say(m, k % 2 === 0 ? 'User' : 'Claude', `S-${k}`));
    s.l1('L1-a', ids.slice(0, 3));
    s.l1('L1-first', ids.slice(3, 6));
    s.l1('L1-second', ids.slice(3, 6));
    await compileAll(m);
    assert.equal(linkOf(s, ids[3]), 'L1-first', 'setup: the first links while neither is held');
    s.l2('L2-x', ['L1-a', 'L1-second'], ids[0], ids[5]);
    await compileAll(m);
    assert.equal(linkOf(s, ids[3]), 'L1-second');
    m.close();
  });

  for (const removal of [false, true]) {
    it(`where a later unheld L1 overlaps L1s an L2 holds, the held ones keep their messages${removal ? ' after a removal' : ''}, so the store opens again`, async () => {
      const { membrane } = stub();
      const s = seeded();
      const m = await open(s, membrane);
      m.setToolDefinitions(TOOLS);
      const x = [0, 1, 2].map((k) => say(m, k % 2 === 0 ? 'User' : 'Claude', `X-${k}`));
      const mid = removal
        ? [0, 1, 2, 3].map((k) => say(m, k % 2 === 0 ? 'User' : 'Claude', `M-${k}`))
        : [call(m, 'o1'), result(m, 'o1'), say(m, 'Claude', 'M-2'), say(m, 'User', 'M-3')];
      const y = [0, 1, 2].map((k) => say(m, k % 2 === 0 ? 'User' : 'Claude', `Y-${k}`));
      s.l1('L1-x', x);
      if (removal) {
        s.l1('L1-m', mid);
        s.l1('L1-y', y);
        s.l2('L2-z', ['L1-x', 'L1-m', 'L1-y'], x[0], y[2]);
        s.l1('L1-prefix', mid.slice(0, 3));
        m.removeMessage(mid[2]);
      } else {
        s.l1('L1-call', mid.slice(0, 2));
        s.l1('L1-talk', mid.slice(2, 4));
        s.l1('L1-y', y);
        s.l2('L2-z', ['L1-x', 'L1-call', 'L1-talk', 'L1-y'], x[0], y[2]);
        s.l1('L1-both', mid);
      }
      m.close();
      (await reopenFindsNothing(membrane)).close();
    });
  }

  it('a result left beside another call once messages between them are removed doesn\'t hold their summaries\' chunks together', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    m.setToolDefinitions(TOOLS);
    await triple(m, 'A');
    const x = say(m, 'User', 'X');
    call(m, 'pa');
    const ra = result(m, 'pa');
    await drain(m);
    const cb = call(m, 'pb');
    const rb = result(m, 'pb');
    await drain(m);
    await triple(m, 'C');
    const l1x = l1Over(s, x)?.id;
    const l1y = l1Over(s, cb)?.id;
    assert.ok(l1x && l1y && l1x !== l1y && l1Over(s, ra)?.id === l1x && l1Over(s, rb)?.id === l1y, 'setup: one L1 ends at the first result, the next begins at the second call');
    m.removeMessage(ra);
    m.removeMessage(cb);
    m.close();
    const again = knowledge();
    const reopened = await open(again, membrane);
    assert.deepEqual(again.getTopologyViolations(), []);
    assert.equal(linkOf(again, x), l1x);
    assert.equal(linkOf(again, rb), l1y);
    reopened.close();
  });

  it('a message a view filter hides from inside a merged summary\'s sources counts as gone: the store opens, its load audit finding nothing, and the rest don\'t go out raw', async () => {
    const { membrane } = stub();
    const s = knowledge();
    const m = await open(s, membrane);
    await triple(m, 'A');
    const b = await triple(m, 'B');
    await triple(m, 'C');
    assert.ok(l2Over(s, l1Over(s, b[1])!.id), 'B\'s L1 is merged');
    m.close();

    const hidden = b[1];
    const reopened = await reopenFindsNothing(membrane, (msg) => msg.id !== hidden);
    const sent = await compileAll(reopened);
    assert.ok(!sentRaw(sent, 'B-0') && !sentRaw(sent, 'B-2'), 'B\'s remaining messages aren\'t sent raw');
    reopened.close();
  });
});
