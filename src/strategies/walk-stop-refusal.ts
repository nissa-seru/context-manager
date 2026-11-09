import { OverBudgetError } from '../adaptive/picker.js';
import type { StoredMessage } from '../types/index.js';

export function walkStopRefusal(
  strategy: string,
  remedies: string,
  message: StoredMessage,
  price: number,
  changes: { count: number; tokens: number },
  maxTokens: number,
): OverBudgetError | undefined {
  const diagnostics = { headTokens: changes.tokens, tailTokens: price, middleTokens: 0, middleChunkCount: 0, deepestLevel: 0 };
  if (changes.count === 0 && maxTokens <= 0) {
    return new OverBudgetError({
      budget: maxTokens,
      actual: price,
      stage: `${strategy}: the budget leaves no room after the response reserve`,
      clearedBy: [],
      diagnostics,
    });
  }
  const room = maxTokens - changes.tokens;
  if (room <= 0 || price <= room) return undefined;
  return new OverBudgetError({
    budget: maxTokens,
    actual: changes.tokens + price,
    stage: `${strategy}: message ${message.id} fits no window (${remedies}); from ${message.participant},`,
    clearedBy: ['newer-message'],
    diagnostics,
  });
}
