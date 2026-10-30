import type { ContentBlock } from '@animalabs/membrane';
import { holdsSystemChange } from '../system-changes.js';

type Held = { readonly content: readonly ContentBlock[] };

function earliestCalls(messages: readonly Held[], through: number): number[] {
  const lastCall = new Map<string, number>();
  const earliest: number[] = [];
  for (let i = 0; i <= through; i++) {
    let first = i;
    for (const block of messages[i]!.content) {
      if (block.type === 'tool_use') lastCall.set((block as { id: string }).id, i);
      else if (block.type === 'tool_result') first = Math.min(first, lastCall.get((block as { toolUseId: string }).toolUseId) ?? i);
    }
    earliest.push(first);
  }
  return earliest;
}

export function openingFrom(messages: readonly Held[], start: number): number {
  const earliest = earliestCalls(messages, messages.length - 1);
  let s = start;
  while (s < messages.length && (holdsSystemChange(messages[s]!.content) || earliest[s]! < s)) s++;
  return s;
}

export function newestConversationMessage(messages: readonly Held[]): number {
  let i = messages.length - 1;
  while (i >= 0 && holdsSystemChange(messages[i]!.content)) i--;
  return i;
}

export function newestTurnStart(messages: readonly Held[]): number {
  const newest = newestConversationMessage(messages);
  if (newest < 0) return newest;
  const earliest = earliestCalls(messages, newest);
  let start = newest;
  while (earliest[start]! < start) start = earliest[start]!;
  return start;
}

export function windowStart(messages: readonly Held[], from: number): number {
  const opening = openingFrom(messages, from);
  if (opening < messages.length) return opening;
  const turn = newestTurnStart(messages);
  return turn < 0 ? messages.length : turn;
}

export function newestTurnStage(prefix: string, changes: boolean, calls: boolean): string {
  const back = calls ? ' back to the tool calls it answers' : '';
  return changes
    ? `${prefix}: its system changes and the newest conversation message${back}`
    : `${prefix}: the newest message${back || ' alone'}`;
}
