import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, OverBudgetError, PassthroughStrategy, WindowedPassthroughStrategy } from '../src/index.js';
import type { CompileResult, ContextStrategy, StoredMessage, TokenBudget } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'cm-window-edges-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let opened = 0;

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const toolUse = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'read_file', input: { path: 'notes.txt' } }) as ContentBlock;
const toolResult = (id: string, t = 'FILE ' + 'line '.repeat(20)): ContentBlock => ({ type: 'tool_result', toolUseId: id, content: t }) as ContentBlock;
const change = (): ContentBlock => ({ type: 'system_change', addSystem: ['Use metric units.'] }) as unknown as ContentBlock;
const BIG: TokenBudget = { maxTokens: 1_000_000, reserveForResponse: 0 };
const budgetOf = (maxTokens: number): TokenBudget => ({ maxTokens, reserveForResponse: 0 });

async function open(strategy: ContextStrategy): Promise<ContextManager> {
  return ContextManager.open({ path: join(dir, `store-${opened++}`), strategy });
}
const estimateOf = (cm: ContextManager, id: string): number =>
  (cm as unknown as { messageStore: { estimateTokens(m: StoredMessage): number } }).messageStore.estimateTokens(cm.getMessage(id)!);
const sum = (cm: ContextManager, ids: string[]): number => ids.reduce((n, id) => n + estimateOf(cm, id), 0);
const rawIds = (compiled: CompileResult): string[] =>
  compiled.provenance!.messages.flatMap((s) => (s.kind === 'raw' ? s.bodies.map((b) => b.messageId) : []));
const holdsResult = (content: readonly unknown[]): boolean => content.some((b) => (b as { type?: string }).type === 'tool_result');
function assertSentAsStored(cm: ContextManager, compiled: CompileResult): void {
  const ids = rawIds(compiled);
  assert.equal(compiled.messages.length, ids.length);
  ids.forEach((id, i) => assert.deepEqual(compiled.messages[i]!.content, cm.getMessage(id)!.content, `message ${i} as stored`));
}

async function toolTurn(strategy: ContextStrategy, edge?: ContentBlock[]): Promise<{ cm: ContextManager; U0: string; A1: string; U2: string; A3: string; U4: string }> {
  const cm = await open(strategy);
  const U0 = cm.addMessage('User', [text('Please read the file.')]);
  const A1 = cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
  const U2 = cm.addMessage('User', edge ?? [toolResult('t1')]);
  const A3 = cm.addMessage('Claude', [text('Read it.')]);
  const U4 = cm.addMessage('User', [text('Thanks.')]);
  return { cm, U0, A1, U2, A3, U4 };
}

describe('passthrough: a request never opens with a tool result whose call the cut left out', () => {
  it('leaves out the result message the cut lands on, whole, and sends the rest as stored', async () => {
    const { cm, U2, A3, U4 } = await toolTurn(new PassthroughStrategy());
    const compiled = await cm.compile(budgetOf(sum(cm, [U2, A3, U4]) + 5));
    assert.deepEqual(rawIds(compiled), [A3, U4]);
    assertSentAsStored(cm, compiled);
  });

  it('leaves out a result message whose result shares it with text', async () => {
    const { cm, U2, A3, U4 } = await toolTurn(new PassthroughStrategy(), [toolResult('t1'), text('And one more question.')]);
    const compiled = await cm.compile(budgetOf(sum(cm, [U2, A3, U4]) + 5));
    assert.deepEqual(rawIds(compiled), [A3, U4]);
  });

  it('leaves out a message holding a result and a call, and the message holding that call\'s result', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Please read both files.')]);
    cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
    const X = cm.addMessage('Claude', [toolResult('t1'), toolUse('t2')]);
    const Y = cm.addMessage('User', [toolResult('t2')]);
    const A = cm.addMessage('Claude', [text('Read them.')]);
    const U = cm.addMessage('User', [text('Thanks.')]);
    const compiled = await cm.compile(budgetOf(sum(cm, [X, Y, A, U]) + 5));
    assert.deepEqual(rawIds(compiled), [A, U]);
  });

  it('sends the system changes before the cut ahead of the first message after it that holds no result', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Please read the file.')]);
    const C = cm.addMessage('Harness', [change()]);
    cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
    const U2 = cm.addMessage('User', [toolResult('t1')]);
    const A3 = cm.addMessage('Claude', [text('Read it.')]);
    const U4 = cm.addMessage('User', [text('Thanks.')]);
    const compiled = await cm.compile(budgetOf(sum(cm, [C, U2, A3, U4]) + 5));
    assert.deepEqual(rawIds(compiled), [C, A3, U4]);
    assertSentAsStored(cm, compiled);
  });

  it('refuses when the newest message is a result that doesn\'t fit beside the messages back to its call', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Please read the file.')]);
    const A1 = cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
    const U2 = cm.addMessage('User', [toolResult('t1')]);
    const budget = estimateOf(cm, U2) + 5;
    await assert.rejects(cm.compile(budgetOf(budget)), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.match(err.message, /^Passthrough: the newest message back to the tool calls it answers/);
      assert.deepEqual(err.clearedBy, ['newer-message']);
      assert.deepEqual([err.budget, err.actual], [budget, sum(cm, [A1, U2])]);
      return true;
    });
    const compiled = await cm.compile(budgetOf(budget), [], { dryRun: true });
    assert.ok(!compiled.messages.some((m) => holdsResult(m.content)), 'a dry compile sends no result without its call');
  });
  it('opens with a message whose tool result answers a call earlier in it, though an earlier call used the same id', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Please check.')]);
    cm.addMessage('Claude', [toolUse('t1')]);
    cm.addMessage('User', [toolResult('t1')]);
    cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600))]);
    const B = cm.addMessage('Claude', [toolUse('t1'), toolResult('t1'), text('Done.')]);
    const U = cm.addMessage('User', [text('Thanks.')]);
    assert.deepEqual([...new Set(rawIds(await cm.compile(budgetOf(sum(cm, [B, U]) + 5))))], [B, U]);
  });

  it('opens with a result whose call the view never held, as stored', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Hello.')]);
    cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600))]);
    const G = cm.addMessage('User', [toolResult('ghost')]);
    const A = cm.addMessage('Claude', [text('Noted.')]);
    const compiled = await cm.compile(budgetOf(sum(cm, [G, A]) + 5));
    assert.deepEqual(rawIds(compiled), [G, A]);
    assertSentAsStored(cm, compiled);
  });

  it('sends a later result whose call the cut left out as stored, when another message opens the request before it', async () => {
    const cm = await open(new PassthroughStrategy());
    cm.addMessage('User', [text('Please read the file.')]);
    cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
    const T = cm.addMessage('User', [text('While it runs: hello.')]);
    const U2 = cm.addMessage('User', [toolResult('t1')]);
    const A3 = cm.addMessage('Claude', [text('Read it.')]);
    const compiled = await cm.compile(budgetOf(sum(cm, [T, U2, A3]) + 5));
    assert.deepEqual(rawIds(compiled), [T, U2, A3]);
    assertSentAsStored(cm, compiled);
  });

});

describe('windowed passthrough: the window never opens with a tool result whose call is before its start, and holds the newest conversation message', () => {
  it('a re-anchor never starts the window at a result message, and a later compile at any budget doesn\'t either', async () => {
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const { cm, U2, A3, U4 } = await toolTurn(strategy);
    const budget = 2 * sum(cm, [U2, A3, U4]) + 2;
    const first = await cm.compile(budgetOf(budget));
    assert.deepEqual(rawIds(first), [A3, U4]);
    assertSentAsStored(cm, first);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [A3, U4]);
  });

  it('an anchor already on a result message gives a window opening after it, and stays where the caller put it', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const { cm, U2, A3, U4 } = await toolTurn(strategy);
    const anchor = cm.getMessage(U2)!.sequence;
    strategy.setAnchor(anchor);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [A3, U4]);
    assert.equal(strategy.getAnchor(), anchor);
  });

  it('an anchor set at the chronicle\'s head sends the newest conversation message until one arrives after it, then the caller\'s anchor holds', async () => {
    const path = join(dir, 'head-anchor');
    const strategy = new WindowedPassthroughStrategy();
    const cm = await ContextManager.open({ path, strategy });
    cm.addMessage('User', [text('first')]);
    const last = cm.addMessage('Claude', [text('second')]);
    const store = cm.getStore();
    store.registerState({ id: 'host/tune-out', strategy: 'snapshot' });
    store.setStateJson('host/tune-out', { startedAtSequence: store.currentSequence() });
    const head = store.currentSequence();
    assert.ok(head > cm.getMessage(last)!.sequence, `setup: the head (${head}) is past the newest message (${cm.getMessage(last)!.sequence})`);
    strategy.setAnchor(head);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [last]);
    assert.equal(strategy.getAnchor(), head, 'the caller\'s anchor stands');
    await cm.close();
    const reopenedStrategy = new WindowedPassthroughStrategy();
    const reopened = await ContextManager.open({ path, strategy: reopenedStrategy });
    assert.equal(reopenedStrategy.getAnchor(), head, 'and is what the store keeps');
    assert.deepEqual(rawIds(await reopened.compile(BIG)), [last]);
    const next = reopened.addMessage('User', [text('third')]);
    assert.deepEqual(rawIds(await reopened.compile(BIG)), [next]);
    await reopened.close();
  });

  it('when the newest conversation message before the anchor is a result, the window starts at its call', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('Please read the file.')]);
    const A1 = cm.addMessage('Claude', [text('Reading.'), toolUse('t1')]);
    const U2 = cm.addMessage('User', [toolResult('t1')]);
    strategy.setAnchor(cm.getStore().currentSequence() + 1);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [A1, U2]);
  });

  it('when the anchored newest message is removed, the window holds the newest message still stored', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('first')]);
    const second = cm.addMessage('Claude', [text('second')]);
    const third = cm.addMessage('User', [text('third')]);
    strategy.setAnchor(cm.getMessage(third)!.sequence);
    cm.removeMessage(third);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [second]);
  });

  it('renderAsNewest renders what select sends at those edges: no result message the window opens past, and the newest message while none is past the anchor', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const { cm, U2, A3, U4 } = await toolTurn(strategy);
    strategy.setAnchor(cm.getMessage(U2)!.sequence);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [A3, U4], 'setup: select opens past the result');
    assert.deepEqual(cm.renderAsNewest([U2, A3, U4]), [null, cm.getMessage(A3)!.content, cm.getMessage(U4)!.content]);
    strategy.setAnchor(cm.getStore().currentSequence() + 1);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [U4], 'setup: select sends the newest message');
    assert.deepEqual(cm.renderAsNewest([A3, U4]), [null, cm.getMessage(U4)!.content]);
  });

  it('refuses when the newest message is a result that doesn\'t fit beside its call', async () => {
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const cm = await open(strategy);
    cm.addMessage('User', [text('Please read the file.')]);
    const A1 = cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
    const U2 = cm.addMessage('User', [toolResult('t1')]);
    const budget = estimateOf(cm, U2) + 5;
    await assert.rejects(cm.compile(budgetOf(budget)), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.match(err.message, /^Windowed passthrough: the newest message back to the tool calls it answers/);
      assert.deepEqual(err.clearedBy, ['newer-message']);
      assert.deepEqual([err.budget, err.actual], [budget, sum(cm, [A1, U2])]);
      return true;
    });
  });
  it('keeps the messages after the anchor when a result whose call is before the anchor arrives later, sending it as stored', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('Please read the file.')]);
    cm.addMessage('Claude', [text('Reading.'), toolUse('t1')]);
    const anchor = cm.getStore().currentSequence() + 1;
    strategy.setAnchor(anchor);
    const T = cm.addMessage('User', [text('While it runs: hello.')]);
    const A2 = cm.addMessage('Claude', [text('Hello.')]);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [T, A2]);
    const U3 = cm.addMessage('User', [toolResult('t1')]);
    const withResult = await cm.compile(BIG);
    assert.deepEqual(rawIds(withResult), [T, A2, U3]);
    assertSentAsStored(cm, withResult);
    const X = cm.addMessage('Claude', [text('Read it.')]);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [T, A2, U3, X]);
    assert.equal(strategy.getAnchor(), anchor);
  });

  it('opens with a result whose call the view never held, as stored, at the anchor', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('Hello.')]);
    const G = cm.addMessage('User', [toolResult('ghost')]);
    const A = cm.addMessage('Claude', [text('Noted.')]);
    strategy.setAnchor(cm.getMessage(G)!.sequence);
    const compiled = await cm.compile(BIG);
    assert.deepEqual(rawIds(compiled), [G, A]);
    assertSentAsStored(cm, compiled);
  });

  it('walks back to the calls the opening message\'s results answer, the nearest with each id, and no further', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('Please read both.')]);
    cm.addMessage('Claude', [toolUse('a')]);
    const B = cm.addMessage('Claude', [toolUse('b')]);
    const RA = cm.addMessage('User', [toolResult('a')]);
    const RB = cm.addMessage('User', [toolResult('b')]);
    strategy.setAnchor(cm.getStore().currentSequence() + 1);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [B, RA, RB]);

    const reused = new WindowedPassthroughStrategy();
    const again = await open(reused);
    again.addMessage('User', [text('Please read it twice.')]);
    again.addMessage('Claude', [toolUse('r')]);
    again.addMessage('User', [toolResult('r')]);
    const A2 = again.addMessage('Claude', [toolUse('r')]);
    const U3 = again.addMessage('User', [toolResult('r')]);
    reused.setAnchor(again.getStore().currentSequence() + 1);
    assert.deepEqual(rawIds(await again.compile(BIG)), [A2, U3]);
  });

  it('a re-anchor inside the newest turn sent from before the anchor leaves the caller\'s anchor where it was', async () => {
    const strategy = new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 });
    const cm = await open(strategy);
    cm.addMessage('User', [text('Please read the file.')]);
    cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
    const T = cm.addMessage('User', [text('While it runs: hello.')]);
    const R = cm.addMessage('User', [toolResult('t1')]);
    const anchor = cm.getStore().currentSequence() + 1;
    strategy.setAnchor(anchor);
    assert.deepEqual(rawIds(await cm.compile(budgetOf(2 * sum(cm, [T, R]) + 2))), [T, R]);
    assert.equal(strategy.getAnchor(), anchor);
  });

  it('walks back by id to the call the newest result answers, past a message between them, and not past a message holding its own call and result', async () => {
    const strategy = new WindowedPassthroughStrategy();
    const cm = await open(strategy);
    cm.addMessage('User', [text('Please read the file.')]);
    const A1 = cm.addMessage('Claude', [text('Reading.'), toolUse('t1')]);
    const T = cm.addMessage('User', [text('While it runs: hello.')]);
    const U2 = cm.addMessage('User', [toolResult('t1')]);
    strategy.setAnchor(cm.getStore().currentSequence() + 1);
    assert.deepEqual(rawIds(await cm.compile(BIG)), [A1, T, U2]);
    const B = cm.addMessage('Claude', [toolUse('t2'), toolResult('t2'), text('Done.')]);
    strategy.setAnchor(cm.getStore().currentSequence() + 1);
    assert.deepEqual([...new Set(rawIds(await cm.compile(BIG)))], [B]);
  });

});

for (const [label, make] of [
  ['Passthrough', () => new PassthroughStrategy()],
  ['Windowed passthrough', () => new WindowedPassthroughStrategy({ reAnchorFraction: 0.5 })],
] as const) {
  it(`${label}: a refusal of the newest result back to its call prices the system changes, the call and the result together`, async () => {
    const cm = await open(make());
    cm.addMessage('User', [text('Please read the file.')]);
    const C = cm.addMessage('Harness', [change()]);
    const A1 = cm.addMessage('Claude', [text('Thinking it over ' + 'word '.repeat(600)), toolUse('t1')]);
    const U2 = cm.addMessage('User', [toolResult('t1')]);
    const budget = sum(cm, [C, U2]) + 5;
    await assert.rejects(cm.compile(budgetOf(budget)), (err: unknown) => {
      assert.ok(err instanceof OverBudgetError, String(err));
      assert.match(err.message, new RegExp(`^${label}: its system changes and the newest conversation message back to the tool calls it answers`));
      assert.deepEqual([err.budget, err.actual], [budget, sum(cm, [C, A1, U2])]);
      assert.deepEqual([err.diagnostics.headTokens, err.diagnostics.tailTokens], [estimateOf(cm, C), sum(cm, [A1, U2])]);
      return true;
    });
  });
}
