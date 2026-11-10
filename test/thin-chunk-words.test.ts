import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { SummaryEntry } from '../src/types/strategy.js';

const dir = mkdtempSync(join(tmpdir(), 'thin-chunk-words-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const INSTRUCTION = 'Go with plan B.';
const OLD_STUB = (n: number) =>
  `(A quiet stretch: ${n} messages of routine system traffic — heartbeats, empty turns, notices. Nothing happened worth remembering.)`;

type Seam = 'pin' | 'system change';

const textsOf = (blocks: readonly any[]): string[] =>
  blocks.filter((b) => typeof b?.text === 'string').map((b) => b.text as string);

function summarizer() {
  const requests: any[] = [];
  const membrane = {
    complete: async (req: any) => {
      requests.push(JSON.parse(JSON.stringify(req)));
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `Model summary #${requests.length}.` }],
        usage: { inputTokens: 500, outputTokens: 100 },
      };
    },
  };
  return { membrane, requests };
}

const strategyFor = (overrides: Record<string, unknown> = {}) =>
  new AutobiographicalStrategy({
    compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, summaryParticipant: 'Claude', adaptiveResolution: false,
    ...overrides,
  } as never);

const long = (i: number) => `OLD-${i} ${'word '.repeat(60)}`;
const who = (i: number) => (i % 2 ? 'Claude' : 'User');

async function storeWith(
  name: string,
  short: Array<{ participant: string; text: string }>,
  seam: Seam,
  overrides: Record<string, unknown> = {},
) {
  const sum = summarizer();
  const strategy = strategyFor(overrides);
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: sum.membrane as never });
  for (let i = 0; i < 8; i++) cm.addMessage(who(i), [{ type: 'text', text: long(i) }] as ContentBlock[]);
  const shortIds = short.map((m) => cm.addMessage(m.participant, [{ type: 'text', text: m.text }] as ContentBlock[]));
  if (seam === 'pin') {
    const brief = cm.addMessage('Claude', [{ type: 'text', text: `A pinned brief. ${'brief '.repeat(60)}` }] as ContentBlock[]);
    cm.markDocument(brief, { name: 'brief' });
  } else {
    cm.addMessage('Harness', [{ type: 'system_change', addSystem: ['Answer in metric units.'] } as unknown as ContentBlock]);
  }
  for (let i = 10; i < 34; i++) cm.addMessage(who(i), [{ type: 'text', text: long(i) }] as ContentBlock[]);
  for (let r = 0; r < 60; r++) { await cm.compile(); await cm.tick(); }
  const summaries = (): SummaryEntry[] => (strategy as unknown as { summaries: SummaryEntry[] }).summaries;
  const l1 = summaries().find((s) => s.level === 1 && s.sourceIds.includes(shortIds[0]!));
  assert.ok(l1, 'setup: an L1 covers the short stretch');
  assert.deepEqual(l1.sourceIds, shortIds, 'setup: the short stretch is a chunk of its own, closed at the seam');
  const estimate = (text: string) =>
    (strategy as unknown as { estimateTokens(c: ContentBlock[]): number }).estimateTokens([{ type: 'text', text }]);
  return { cm, strategy, l1, shortIds, requests: sum.requests, summaries, estimate };
}

type StateStore = { store: { setStateJson(id: string, value: unknown): void; getStateJson(id: string): unknown }; summariesStateId: string };

function storedSummaries(strategy: AutobiographicalStrategy): SummaryEntry[] {
  const internals = strategy as unknown as StateStore;
  return internals.store.getStateJson(internals.summariesStateId) as SummaryEntry[];
}

function plantOldStub(built: { strategy: AutobiographicalStrategy; l1: SummaryEntry }): void {
  const internals = built.strategy as unknown as StateStore;
  const stored = storedSummaries(built.strategy).map((s) => (s.id === built.l1.id ? { ...s, content: OLD_STUB(1), tokens: 40 } : s));
  internals.store.setStateJson(internals.summariesStateId, stored);
}

describe("a thin chunk's L1 keeps its own words", () => {
  for (const seam of ['pin', 'system change'] as const) {
    it(`an instruction alone before a ${seam} is kept word for word, priced at its size, with no model call`, async () => {
      const { cm, l1, requests, estimate } = await storeWith(`alone-${seam.replace(' ', '-')}`, [{ participant: 'User', text: INSTRUCTION }], seam);
      assert.equal(l1.content, `User: ${INSTRUCTION}`);
      assert.equal(l1.tokens, estimate(`User: ${INSTRUCTION}`));
      const raw = requests.filter((r) => r.messages.some((m: any) => textsOf(m.content).includes(INSTRUCTION)));
      const l1Requests = raw.filter((r) => !textsOf(r.messages.flatMap((m: any) => m.content)).some((t) => t.includes('consolidate into a single L')));
      assert.equal(l1Requests.length, 0, 'no L1 request was made over the instruction');
      const recalled = requests.filter((r) => r.messages.some((m: any) => textsOf(m.content).includes(`User: ${INSTRUCTION}`)));
      assert.ok(recalled.length > 0, "a later chunk's L1 request recalls the instruction's words");
      cm.close();
    });
  }

  it('with the guard off, the same chunk gets a model summary', async () => {
    const { cm, l1 } = await storeWith('guard-off', [{ participant: 'User', text: INSTRUCTION }], 'pin', { minChunkCharsForLLM: 0 });
    assert.match(l1.content, /^Model summary #\d+\.$/);
    cm.close();
  });

  it('a short exchange keeps each message on its own line, and text that already names its speaker is named once', async () => {
    const { cm, l1 } = await storeWith('exchange', [
      { participant: 'User', text: 'User: Which plan?' },
      { participant: 'Claude', text: '  B, I think.  ' },
    ], 'pin');
    assert.equal(l1.content, 'User: Which plan?\nClaude: B, I think.');
    cm.close();
  });

  it('a chunk with no text says so, and counts its messages', async () => {
    const one = await storeWith('blank-one', [{ participant: 'User', text: '   ' }], 'pin');
    assert.equal(one.l1.content, '(1 message, none with text.)');
    one.cm.close();
    const two = await storeWith('blank-two', [{ participant: 'User', text: ' ' }, { participant: 'Claude', text: '\n' }], 'pin');
    assert.equal(two.l1.content, '(2 messages, none with text.)');
    two.cm.close();
  });

  it("an older release's stub over words still in the store is rewritten to them when the store opens", async () => {
    const built = await storeWith('old-stub', [{ participant: 'User', text: INSTRUCTION }], 'pin');
    const model = built.summaries().find((s) => s.level === 1 && s.id !== built.l1.id)!;
    plantOldStub(built);
    built.cm.close();

    const strategy = strategyFor();
    const cm = await ContextManager.open({ path: join(dir, 'old-stub'), strategy, membrane: summarizer().membrane as never });
    const reopened = (strategy as unknown as { summaries: SummaryEntry[] }).summaries;
    const rewritten = reopened.find((s) => s.id === built.l1.id)!;
    assert.equal(rewritten.content, `User: ${INSTRUCTION}`);
    assert.equal(rewritten.tokens, built.estimate(`User: ${INSTRUCTION}`));
    assert.equal(reopened.find((s) => s.id === model.id)!.content, model.content, 'a model L1 is left as it was');
    const persisted = storedSummaries(strategy).find((s) => s.id === built.l1.id)!;
    assert.equal(persisted.content, `User: ${INSTRUCTION}`, 'the rewrite is stored');
    cm.close();
  });

  it("an audit-only open leaves an older release's stub as it was", async () => {
    const built = await storeWith('old-stub-audit', [{ participant: 'User', text: INSTRUCTION }], 'pin');
    plantOldStub(built);
    built.cm.close();

    const strategy = strategyFor({ auditOnly: true });
    const cm = await ContextManager.open({ path: join(dir, 'old-stub-audit'), strategy, membrane: summarizer().membrane as never });
    assert.equal((strategy as unknown as { summaries: SummaryEntry[] }).summaries.find((s) => s.id === built.l1.id)!.content, OLD_STUB(1));
    const persisted = storedSummaries(strategy).find((s) => s.id === built.l1.id)!;
    assert.equal(persisted.content, OLD_STUB(1));
    cm.close();
  });

  it("an older release's stub whose words have left the store is left as it was", async () => {
    const built = await storeWith('old-stub-gone', [{ participant: 'User', text: INSTRUCTION }], 'pin');
    plantOldStub(built);
    built.cm.removeMessage(built.shortIds[0]!);
    built.cm.close();

    const strategy = strategyFor();
    const cm = await ContextManager.open({ path: join(dir, 'old-stub-gone'), strategy, membrane: summarizer().membrane as never });
    const kept = (strategy as unknown as { summaries: SummaryEntry[] }).summaries.find((s) => s.id === built.l1.id);
    assert.ok(kept, 'setup: the stub is still held after its source left');
    assert.equal(kept.content, OLD_STUB(1));
    cm.close();
  });
});
