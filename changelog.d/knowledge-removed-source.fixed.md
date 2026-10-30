- `KnowledgeStrategy` keeps an L1 summary standing for its remaining messages
  after one of its sources is removed or hidden by a `viewFilter`. Before, the
  rebuilt chunk over the remaining messages no longer matched the summary's
  sources, so the summary stood for nothing: those messages went out raw beside
  it, and once a level-2 summary held it, whether merged before or after the
  removal, the store's next open refused with `StoreTopologyError` ("summary
  owns non-contiguous leaves") under the default `topologyPolicy: 'reject'`.
  A store already in that state opens again with no repair step.
