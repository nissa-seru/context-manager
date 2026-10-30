- `KnowledgeStrategy` keeps an L1 summary standing for its messages that
  remain after one of its sources is removed, hidden by a `viewFilter` or
  pinned raw, a tool call whose result stays included. Before, the chunk the
  next rebuild cut over the remaining messages no longer matched the summary's
  sources, so the summary stood for nothing: those messages went out raw
  beside it, and once a level-2 summary held it between two others, whether
  merged before or after, the store's next open refused with
  `StoreTopologyError` ("summary owns non-contiguous leaves") under the default
  `topologyPolicy: 'reject'`. Where two L1s cover the same messages, or
  overlap, the one a level-2 summary holds now keeps them; before, the first
  listed or the last overlapping one did, and a store whose level-2 summary
  held the other refused to open the same way. A store already in one of
  these states opens again with no repair step.
  Where a summary ends at tool calls answered only after it, and the next
  summary already holds one of those results, both summaries now stay linked:
  a later result for another of the calls goes out without its call, so its
  output isn't sent. Before, the two summaries' messages were joined and sent
  raw, which made such a store refuse to open once a level-2 summary held
  them between two others; and that later result's output was left out of
  the summary its own chunk was compressed into, then as now.
