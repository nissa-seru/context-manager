import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, OverBudgetError, PassthroughStrategy, WindowedPassthroughStrategy } from '../src/index.js';
import type { CompileResult, ContextStrategy, StoredMessage, TokenBudget } from '../src/types/index.js';

const dir = mkdtempSync(join(tmpdir(), 'cm-oversized-message-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let opened = 0;
const open = (strategy: ContextStrategy): Promise<ContextManager> =>
  ContextManager.open({ path: join(dir, `store-${opened++}`), strategy });

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const estimateOf = (cm: ContextManager, id: string): number =>
  (cm as unknown as { messageStore: { estimateTokens(m: StoredMessage): number } }).messageStore.estimateTokens(cm.getMessage(id)!);
const rawIds = (compiled: CompileResult): string[] =>
  compiled.provenance!.messages.flatMap((s) => (s.kind === 'raw' ? s.bodies.map((b) => b.messageId) : []));

const BUDGET: TokenBudget = { maxTokens: 1000, reserveForResponse: 0 };
const OPEN: TokenBudget = { maxTokens: 1_000_000, reserveForResponse: 0 };
const PASTER = 'a-participant-named-thirty-two-c';
// What agent-framework's context-refusal alert keeps of a longer reason's head.
const ALERT_HEAD = 195;

const history = (cm: ContextManager): string[] =>
  [0, 1, 2].map((i) => cm.addMessage(i % 2 ? 'Claude' : 'User', text(`older ${i} ${'word '.repeat(20)}`)));
function paste(cm: ContextManager): string {
  const id = cm.addMessage(PASTER, text(`paste ${'word '.repeat(3000)}`));
  assert.ok(estimateOf(cm, id) > BUDGET.maxTokens, 'setup: the paste is larger than the room');
  return id;
}

async function refusal(cm: ContextManager, budget: TokenBudget = BUDGET): Promise<OverBudgetError> {
  let sent: string[];
  try {
    sent = rawIds(await cm.compile(budget));
  } catch (err) {
    assert.ok(err instanceof OverBudgetError, String(err));
    return err;
  }
  return assert.fail(`no refusal: the compile sent ${JSON.stringify(sent)}`);
}

function assertNames(err: OverBudgetError, cm: ContextManager, id: string, windowed: boolean): void {
  const head = err.message.slice(0, ALERT_HEAD);
  assert.match(head, new RegExp(`message ${id}\\b`), `the alert's head names the message: ${err.message}`);
  assert.ok(head.includes(PASTER), `the alert's head names its participant: ${err.message}`);
  assert.ok(head.includes('remove or edit it'), `the alert's head says removing or editing it clears it: ${err.message}`);
  assert.ok(head.includes('raise the budget'), `the alert's head says a larger budget clears it: ${err.message}`);
  if (windowed) assert.ok(head.includes('maxMessageTokens'), `the alert's head names windowed's cap: ${err.message}`);
  assert.ok(head.includes(`${err.actual} tokens still exceed hard budget ${err.budget}`), `the alert's head holds the numbers: ${err.message}`);
  assert.deepEqual([err.actual, err.budget], [estimateOf(cm, id), BUDGET.maxTokens], 'the message against the room');
  assert.deepEqual([err.diagnostics.headTokens, err.diagnostics.tailTokens], [0, estimateOf(cm, id)]);
  assert.deepEqual(err.clearedBy, ['newer-message']);
}

for (const [label, make, windowed] of [
  ['passthrough', (): ContextStrategy => new PassthroughStrategy(), false],
  ['windowed-passthrough', (): ContextStrategy => new WindowedPassthroughStrategy(), true],
] as const) {
  const anchorOf = (strategy: ContextStrategy): number | undefined =>
    strategy instanceof WindowedPassthroughStrategy ? strategy.getAnchor() : undefined;

  describe(`${label}: a message larger than the room`, () => {
    it('as the newest message, after older history that fits, refuses naming it, and a dry compile reports instead', async () => {
      const strategy = make();
      const cm = await open(strategy);
      history(cm);
      const big = paste(cm);
      const anchor = anchorOf(strategy);
      assertNames(await refusal(cm), cm, big, windowed);
      assert.equal(anchorOf(strategy), anchor, 'the refusal moved no anchor');
      await cm.compile(BUDGET, undefined, { dryRun: true });
      await cm.close();
    });

    it('still refuses once a short message follows it, and the anchor stays where the refusal left it', async () => {
      const strategy = make();
      const cm = await open(strategy);
      history(cm);
      const big = paste(cm);
      await refusal(cm);
      const anchor = anchorOf(strategy);
      cm.addMessage('User', text('did you get that?'));
      assertNames(await refusal(cm), cm, big, windowed);
      assert.equal(anchorOf(strategy), anchor, 'the refusal moved no anchor');
      await cm.close();
    });

    it('as the first message, refuses once a short message follows it', async () => {
      const cm = await open(make());
      const big = paste(cm);
      cm.addMessage('User', text('did you get that?'));
      assertNames(await refusal(cm), cm, big, windowed);
      await cm.close();
    });

    it('is left out with the history before it once newer conversation alone overflows the room', async () => {
      const cm = await open(make());
      const older = history(cm);
      const big = paste(cm);
      const newer: string[] = [];
      for (let total = 0; total <= BUDGET.maxTokens;) {
        newer.push(cm.addMessage('User', text(`newer ${newer.length} ${'word '.repeat(20)}`)));
        total += estimateOf(cm, newer.at(-1)!);
      }
      const sent = rawIds(await cm.compile(BUDGET));
      assert.ok(![big, ...older].some((id) => sent.includes(id)), `the paste and the older history are left out: ${JSON.stringify(sent)}`);
      assert.equal(sent.at(-1), newer.at(-1));
      await cm.close();
    });

    it('once removed, or edited to fit, gives back the older history the refusals kept in reach', async () => {
      for (const clear of ['remove', 'edit'] as const) {
        const cm = await open(make());
        const older = history(cm);
        const big = paste(cm);
        await refusal(cm);
        const newer = cm.addMessage('User', text('did you get that?'));
        await refusal(cm);
        if (clear === 'remove') cm.removeMessage(big);
        else cm.editMessage(big, text('paste, cut short'));
        assert.deepEqual(rawIds(await cm.compile(BUDGET)), clear === 'remove' ? [...older, newer] : [...older, big, newer], clear);
        await cm.close();
      }
    });

    it('after the refusals, a budget that holds every message sends every message', async () => {
      const cm = await open(make());
      const older = history(cm);
      const big = paste(cm);
      await refusal(cm);
      const newer = cm.addMessage('User', text('did you get that?'));
      await refusal(cm);
      assert.deepEqual(rawIds(await cm.compile(OPEN)), [...older, big, newer]);
      await cm.close();
    });
  });
}

describe('windowed-passthrough: a message larger than the room, under maxMessageTokens', () => {
  it('is cut with its marker and sent with the history around it', async () => {
    const cm = await open(new WindowedPassthroughStrategy({ maxMessageTokens: 100 }));
    const older = history(cm);
    const big = paste(cm);
    const newer = cm.addMessage('User', text('did you get that?'));
    const compiled = await cm.compile(BUDGET);
    assert.deepEqual(rawIds(compiled), [...older, big, newer]);
    const sentPaste = compiled.messages.find((m) => (m.content[0] as { text?: string }).text?.startsWith('paste'));
    assert.match((sentPaste!.content[0] as { text: string }).text, /\[truncated — original was/);
    await cm.close();
  });
});
