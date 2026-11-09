import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StrategyContext, SummaryEntry } from '../src/types/strategy.js';
import type { StoredMessage } from '../src/types/message.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-dearer-summaries';
const made: string[] = [];
after(() => {
  for (const p of made) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
});

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }];
const words = (n: number): string => 'substantive words about real happenings '.repeat(n);
const call = (id: string): ContentBlock[] =>
  [{ type: 'text', text: words(8) }, { type: 'tool_use', id, name: 'lookup', input: { q: id } }] as ContentBlock[];
const result = (id: string, note = 'found '): ContentBlock[] =>
  [{ type: 'tool_result', toolUseId: id, content: note + words(8) }] as ContentBlock[];

class Summaries extends AutobiographicalStrategy {
  all(): SummaryEntry[] {
    return this.summaries;
  }
  leavesOf(id: string): string[] {
    const byId = new Map(this.summaries.map((s) => [s.id, s]));
    const out = new Set<string>();
    const summary = byId.get(id);
    if (summary) this.expandSummaryToLeafMessageIds(summary, byId, out);
    return [...out];
  }
  /** A summary of `sources`: messages for an L1, summaries for a level above. */
  seed(id: string, level: number, sources: string[], first: string, last: string): SummaryEntry {
    const s = {
      id, level, content: `${id} recalls what happened`, tokens: 8, sourceLevel: level - 1, sourceIds: sources,
      sourceRange: { first, last }, created: Date.now(),
    } as SummaryEntry;
    this.summaries.push(s);
    return s;
  }
  charge(s: SummaryEntry): number {
    return this.recallPairCost(s, this.buildRecallHeader(s));
  }
  answerCharge(s: SummaryEntry): number {
    return this.recallAnswerCost(s).cost;
  }
  rawPrice(ctx: StrategyContext, m: StoredMessage): number {
    return ctx.messageStore.estimateTokens(this.prunedForSend(ctx.messageStore, m));
  }
}

const contextOf = (manager: ContextManager): StrategyContext =>
  (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();

let stores = 0;

/** #407's store: 32 messages, seven L1s of four by a stub summarizer, and four messages no summary covers. */
const issueStore = (manager: ContextManager): void => {
  for (let i = 0; i < 32; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
};

async function built(extra: Record<string, unknown> = {}, write: (manager: ContextManager) => void = issueStore) {
  const path = `${STORE}-${process.pid}-${stores++}`;
  made.push(path);
  let calls = 0;
  const membrane = {
    complete: async () => ({ stopReason: 'end_turn', content: text(`[summary ${++calls}] brief`), usage: { input_tokens: 100, output_tokens: 10 } }),
  };
  const strategy = new Summaries({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    mergeThreshold: 100,
    autoTickOnNewMessage: false,
    hierarchical: true,
    overBudgetGraceRatio: 0,
    ...extra,
  } as never);
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  const ctx = contextOf(manager);
  write(manager);
  for (let i = 0; i < 2000 && !manager.isReady(); i++) await manager.tick();
  assert.ok(manager.isReady(), 'premise: compression converged');
  const all = ctx.messageStore.getAll();
  const ids = all.map((m) => m.id);
  const position = new Map(all.map((m, i) => [m.id, i]));
  const byId = new Map(all.map((m) => [m.id, m]));
  const rawOf = (leaves: readonly string[]): number => leaves.reduce((sum, id) => sum + strategy.rawPrice(ctx, byId.get(id)!), 0);
  const leavesOf = (s: SummaryEntry): string[] => strategy.leavesOf(s.id).sort((a, b) => position.get(a)! - position.get(b)!);
  const l1s = (): SummaryEntry[] => strategy.all().filter((s) => s.level === 1 && !s.mergedInto)
    .sort((a, b) => position.get(leavesOf(a)[0]!)! - position.get(leavesOf(b)[0]!)!);
  const estimate = (s: string): number => ctx.messageStore.estimateTokens({ content: text(s) } as never);
  /** Rewrites `s` to cost about `factor` times its messages, and checks it costs more than they do. */
  const dearer = (s: SummaryEntry, factor = 2): void => {
    const phrase = 'a long recollection of everything said in those moments ';
    const raw = rawOf(leavesOf(s));
    s.content = phrase.repeat(Math.ceil((factor * raw) / (estimate(phrase.repeat(100)) / 100)));
    s.tokens = estimate(s.content);
    assert.ok(strategy.charge(s) > raw, `premise: ${s.id}'s pair (${strategy.charge(s)}) costs more than its messages (${raw})`);
  };
  const keyOf = (b: ContentBlock): string | null => {
    const block = b as { type: string; id?: string; toolUseId?: string };
    return block.type === 'tool_use' ? `call ${block.id}` : block.type === 'tool_result' ? `result ${block.toolUseId}` : null;
  };
  const sent = async (maxTokens: number) => {
    const compiled = await manager.compile({ maxTokens, reserveForResponse: 0 });
    const sources = compiled.provenance!.messages;
    const rawList = sources.flatMap((m) => (m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : []));
    const summaries = new Set(sources.flatMap((m) => (m.kind === 'summary' ? m.summaries.map((x) => x.id) : [])));
    const total = compiled.messages.reduce((sum, m) => sum + ctx.messageStore.estimateTokens({ content: m.content } as never), 0);
    // A tool block of a message sent raw that the request doesn't carry.
    const carried = new Map<string, Map<string, number>>();
    sources.forEach((m, i) => {
      if (m.kind !== 'raw') return;
      for (const body of m.bodies) {
        const counts = carried.get(body.messageId) ?? new Map<string, number>();
        for (const b of compiled.messages[i]!.content as ContentBlock[]) {
          const key = keyOf(b);
          if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        carried.set(body.messageId, counts);
      }
    });
    const lost: string[] = [];
    for (const [id, counts] of carried) {
      const stored = new Map<string, number>();
      for (const b of byId.get(id)?.content ?? []) {
        const key = keyOf(b);
        if (key) stored.set(key, (stored.get(key) ?? 0) + 1);
      }
      for (const [key, n] of stored) if ((counts.get(key) ?? 0) < n) lost.push(`${key} of message ${position.get(id)}`);
    }
    for (const m of compiled.messages) {
      for (const b of m.content as ContentBlock[]) if (b.type === 'text' && (b as { text: string }).text === '[tool call omitted]') lost.push('[tool call omitted]');
    }
    return { raw: new Set(rawList), rawList, summaries, total, lost, compiled };
  };
  /** Each of `leaves` goes out raw once, in store order. */
  const rawInOrder = (wide: Awaited<ReturnType<typeof sent>>, leaves: readonly string[]): void => {
    for (const id of leaves) assert.equal(wide.rawList.filter((x) => x === id).length, 1, `message ${position.get(id)} goes out raw once`);
    const order = leaves.map((id) => wide.rawList.indexOf(id));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `in store order (${order.join(',')})`);
  };
  return { manager, strategy, ctx, ids, position, rawOf, leavesOf, l1s, dearer, sent, rawInOrder };
}

/** A store no chunk closes in, with `write`'s messages between four before and six after. */
const frontier = (write: (manager: ContextManager) => void) => built({ targetChunkTokens: 1e9 }, (manager) => {
  for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`event ${i} ` + words(8)));
  write(manager);
  for (let i = 0; i < 6; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`later ${i} ` + words(8)));
});

describe('a summary weighed against its messages sent raw, on the hierarchical select', () => {
  it("#407: sends an L1's messages raw in its place where its pair costs more than they do, and fits the budget they need", async () => {
    const f = await built();
    const l1s = f.l1s();
    assert.ok(l1s.length >= 3, `premise: several L1s (${l1s.length})`);
    const dear = l1s[1]!;
    const leaves = f.leavesOf(dear);
    f.dearer(dear);

    const wide = await f.sent(1_000_000);
    assert.ok(!wide.summaries.has(dear.id), 'no recall pair for the L1');
    f.rawInOrder(wide, leaves);
    for (const s of l1s) if (s !== dear) assert.ok(wide.summaries.has(s.id), `${s.id}, cheaper than its messages, goes out`);
    const fits = await f.sent(wide.total);
    assert.ok(!fits.summaries.has(dear.id), `a budget of what that sends (${wide.total}) compiles`);
    await f.manager.close();
  });

  it('sends a summary that costs exactly what its messages do as those messages, and one a token cheaper as its pair', async () => {
    const f = await built();
    const s = f.l1s()[1]!;
    const leaves = f.leavesOf(s);
    const raw = f.rawOf(leaves);
    s.responseContent = text('in brief');
    s.tokens = 1;
    const label = f.strategy.charge(s) - f.strategy.answerCharge(s);
    for (const [tokens, swapped] of [[raw - label, true], [raw - label - 1, false]] as const) {
      s.tokens = tokens;
      assert.equal(f.strategy.charge(s), swapped ? raw : raw - 1, `premise: the pair costs ${swapped ? 'what its messages do' : 'a token less than its messages'}`);
      const wide = await f.sent(1_000_000);
      if (swapped) {
        assert.ok(!wide.summaries.has(s.id), 'at a tie, no recall pair');
        f.rawInOrder(wide, leaves);
      } else {
        assert.ok(wide.summaries.has(s.id), 'a token cheaper, the pair goes out');
        for (const id of leaves) assert.ok(!wide.raw.has(id), `message ${f.position.get(id)} doesn't go out raw`);
      }
    }
    await f.manager.close();
  });

  it('sends an L2 whose pair costs more than all its messages as those messages, with none of the summaries under it', async () => {
    const f = await frontier((manager) => {
      for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`middle ${i} ` + words(8)));
    });
    const leaves = f.ids.slice(4, 12);
    const first = f.strategy.seed('L1-first', 1, leaves.slice(0, 4), leaves[0]!, leaves[3]!);
    const second = f.strategy.seed('L1-second', 1, leaves.slice(4), leaves[4]!, leaves[7]!);
    const l2 = f.strategy.seed('L2-over-both', 2, [first.id, second.id], leaves[0]!, leaves[7]!);
    first.mergedInto = second.mergedInto = l2.id;
    f.dearer(l2);

    const wide = await f.sent(1_000_000);
    for (const s of [l2, first, second]) assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    f.rawInOrder(wide, leaves);
    await f.manager.close();
  });

  const overlapping = async (bothDear: boolean) => {
    const f = await frontier((manager) => {
      for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`middle ${i} ` + words(8)));
    });
    const leaves = f.ids.slice(4, 12);
    const unmerged = f.strategy.seed('L1-unmerged', 1, leaves.slice(0, 4), leaves[0]!, leaves[3]!);
    const merged = f.strategy.seed('L1-merged', 1, leaves.slice(4), leaves[4]!, leaves[7]!);
    const l2 = f.strategy.seed('L2-over-both', 2, [unmerged.id, merged.id], leaves[0]!, leaves[7]!);
    merged.mergedInto = l2.id;
    const before = await f.sent(1_000_000);
    assert.ok(before.summaries.has(l2.id) && before.summaries.has(unmerged.id), 'premise: the select sends the L2 and the L1 it never marked as merged into it');
    f.dearer(unmerged);
    if (bothDear) f.dearer(l2);
    else assert.ok(f.strategy.charge(l2) < f.rawOf(leaves.slice(4)), "premise: the L2 costs less than the messages the L1 doesn't hold");
    return { f, leaves, unmerged, l2 };
  };

  it('sends an L1 as its messages raw under an L2 that also covers them and costs less than its own', async () => {
    const { f, leaves, unmerged, l2 } = await overlapping(false);
    const wide = await f.sent(1_000_000);
    assert.ok(!wide.summaries.has(unmerged.id), 'no recall pair for the L1');
    assert.ok(wide.summaries.has(l2.id), 'the L2 goes out');
    f.rawInOrder(wide, leaves.slice(0, 4));
    await f.manager.close();
  });

  it('sends each message once where an L1 and an L2 over it both cost more than their messages', async () => {
    const { f, leaves, unmerged, l2 } = await overlapping(true);
    const wide = await f.sent(1_000_000);
    for (const s of [unmerged, l2]) assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    f.rawInOrder(wide, leaves);
    await f.manager.close();
  });

  it('sends each message once where an L2 whose L1s overlap costs more than its messages', async () => {
    const f = await frontier((manager) => {
      for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'agent' : 'user', text(`middle ${i} ` + words(8)));
    });
    const leaves = f.ids.slice(4, 10);
    const first = f.strategy.seed('L1-first', 1, leaves.slice(0, 4), leaves[0]!, leaves[3]!);
    const second = f.strategy.seed('L1-second', 1, leaves.slice(2), leaves[2]!, leaves[5]!);
    const l2 = f.strategy.seed('L2-over-both', 2, [first.id, second.id], leaves[0]!, leaves[5]!);
    first.mergedInto = second.mergedInto = l2.id;
    f.dearer(l2);

    const wide = await f.sent(1_000_000);
    for (const s of [l2, first, second]) assert.ok(!wide.summaries.has(s.id), `no recall pair for ${s.id}`);
    f.rawInOrder(wide, leaves);
    await f.manager.close();
  });

  it('with positionedRecallPairs false and no maxMessageTokens, sends the messages raw after the combined pair in place of a summary that costs more than they do; with a cap, keeps it in the combined answer', async () => {
    for (const capped of [false, true]) {
      const f = await built({ positionedRecallPairs: false, ...(capped ? { maxMessageTokens: 1_000_000 } : {}) });
      const dear = f.l1s()[1]!;
      const leaves = f.leavesOf(dear);
      f.dearer(dear);
      const wide = await f.sent(1_000_000);
      if (capped) {
        assert.ok(wide.summaries.has(dear.id), 'under a cap the L1 stays in the combined answer');
        for (const id of leaves) assert.ok(!wide.raw.has(id), `message ${f.position.get(id)} doesn't go out raw`);
      } else {
        assert.ok(!wide.summaries.has(dear.id), 'the combined answer leaves the L1 out');
        f.rawInOrder(wide, leaves);
        const sources = wide.compiled.provenance!.messages;
        const pairAt = sources.findIndex((m) => m.kind === 'summary');
        const firstRaw = sources.findIndex((m) => m.kind === 'raw' && m.bodies.some((b) => b.messageId === leaves[0]));
        assert.ok(pairAt >= 0 && pairAt < firstRaw, 'its messages go out after the combined pair');
        const fits = await f.sent(wide.total);
        assert.ok(!fits.summaries.has(dear.id), `a budget of what that sends (${wide.total}) compiles`);
      }
      await f.manager.close();
    }
  });

  it("keeps a summary one of whose messages is no longer in the store's view, since it alone still holds that message", async () => {
    const f = await built();
    const dear = f.l1s()[1]!;
    const leaves = f.leavesOf(dear);
    f.dearer(dear);
    f.manager.removeMessage(leaves[1]! as never);
    assert.equal((f.manager as unknown as { windowMode(): string }).windowMode(), 'legacy', 'premise: the removal leaves what folded the message');
    const wide = await f.sent(1_000_000);
    assert.ok(wide.summaries.has(dear.id), 'the L1 goes out');
    for (const id of leaves) assert.ok(!wide.raw.has(id), `message ${f.position.get(id)} doesn't go out raw`);
    await f.manager.close();
  });

  // Each shape: the messages the summary holds, what the request sends in its place, and whether a raw send keeps its tool rounds whole.
  const shapes: Array<{ shape: string; swaps: boolean; seed: (f: Awaited<ReturnType<typeof frontier>>, ids: string[]) => SummaryEntry; write: (manager: ContextManager) => string[] }> = [
    { shape: "a result answering a call in another summary", swaps: false,
      write: (manager) => {
        const ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-x'))];
        const meanwhile = manager.addMessage('user', text('meanwhile ' + words(8)));
        manager.pinRange(meanwhile, meanwhile);
        return [...ids, meanwhile, manager.addMessage('user', result('call-x')), manager.addMessage('agent', text('so ' + words(8)))];
      },
      seed: (f, ids) => {
        f.strategy.seed('L1-calls', 1, ids.slice(0, 2), ids[0]!, ids[1]!);
        return f.strategy.seed('L1-answers', 1, ids.slice(3), ids[3]!, ids[4]!);
      } },
    { shape: 'a result answering a call in the summary beside it', swaps: false,
      write: (manager) => [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-c')),
        manager.addMessage('user', result('call-c')), manager.addMessage('agent', text('so ' + words(8)))],
      seed: (f, ids) => {
        f.strategy.seed('L1-calls', 1, ids.slice(0, 2), ids[0]!, ids[1]!);
        return f.strategy.seed('L1-answers', 1, ids.slice(2), ids[2]!, ids[3]!);
      } },
    { shape: 'a call, a message, then its result', swaps: false,
      write: (manager) => [manager.addMessage('agent', call('call-l')), manager.addMessage('user', text('meanwhile ' + words(8))), manager.addMessage('user', result('call-l'))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[2]!) },
    { shape: 'a result that answers no call', swaps: false,
      write: (manager) => [manager.addMessage('agent', text('before ' + words(8))), manager.addMessage('user', result('call-gone'))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'two results for one call', swaps: false,
      write: (manager) => [manager.addMessage('agent', call('call-d')),
        manager.addMessage('user', [...result('call-d'), ...result('call-d', 'found again ')] as ContentBlock[])],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'messages between a call and its result that no summary covers', swaps: false,
      write: (manager) => [
        manager.addMessage('user', text('before ' + words(8))),
        manager.addMessage('agent', call('call-gap')),
        ...[0, 1, 2, 3].map((i) => manager.addMessage(i % 2 ? 'agent' : 'user', text(`meanwhile ${i} ` + words(8)))),
        manager.addMessage('user', result('call-gap')),
        manager.addMessage('agent', text('after ' + words(8))),
      ],
      seed: (f, ids) => {
        const children = [f.strategy.seed('L1-a', 1, [ids[0]!], ids[0]!, ids[0]!), f.strategy.seed('L1-b', 1, ids.slice(2, 6), ids[2]!, ids[5]!), f.strategy.seed('L1-c', 1, [ids[7]!], ids[7]!, ids[7]!)];
        const l2 = f.strategy.seed('L2-around-a-call', 2, children.map((c) => c.id), ids[0]!, ids[7]!);
        for (const c of children) c.mergedInto = l2.id;
        return l2;
      } },
    { shape: 'a call answered right after them by a message no summary covers', swaps: true,
      write: (manager) => {
        const ids = [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-n'))];
        manager.addMessage('user', result('call-n'));
        return ids;
      },
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'a result answering the call before them, a call and its result, and a call answered after them, all in one message', swaps: true,
      write: (manager) => {
        manager.addMessage('agent', call('call-p1'));
        const ids = [manager.addMessage('user', [...result('call-p1'), ...call('call-p2'), ...result('call-p2'), { type: 'tool_use', id: 'call-p3', name: 'lookup', input: { q: 'p3' } }] as ContentBlock[])];
        manager.addMessage('user', result('call-p3'));
        return ids;
      },
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[0]!) },
    { shape: 'a call no result answers', swaps: true,
      write: (manager) => [manager.addMessage('user', text('ask ' + words(8))), manager.addMessage('agent', call('call-none'))],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[1]!) },
    { shape: 'two calls sharing an id in one message, then a result', swaps: false,
      write: (manager) => [
        manager.addMessage('user', text('ask ' + words(8))),
        manager.addMessage('agent', [...call('call-twice'), { type: 'tool_use', id: 'call-twice', name: 'lookup', input: { q: 'again' } }] as ContentBlock[]),
        manager.addMessage('user', result('call-twice')),
        manager.addMessage('agent', text('so ' + words(8))),
      ],
      seed: (f, ids) => f.strategy.seed('L1-cycle', 1, ids, ids[0]!, ids[3]!) },
  ];
  for (const { shape, swaps, write, seed } of shapes) {
    it(`${swaps ? 'sends as its messages' : 'keeps'} a summary that costs more than its messages where they hold ${shape}, and the request keeps every tool block of a message it sends raw`, async () => {
      let ids: string[] = [];
      const f = await frontier((manager) => { ids = write(manager); });
      const s = seed(f, ids);
      f.dearer(s);
      const wide = await f.sent(1_000_000);
      assert.equal(wide.summaries.has(s.id), !swaps, swaps ? `no recall pair for ${s.id}` : `${s.id} goes out`);
      for (const id of f.leavesOf(s)) assert.equal(wide.raw.has(id), swaps, `message ${f.position.get(id)} ${swaps ? 'goes' : "doesn't go"} out raw`);
      assert.deepEqual(wide.lost, [], 'no tool block of a message sent raw is lost');
      await f.manager.close();
    });
  }
});
