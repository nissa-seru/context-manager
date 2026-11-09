- On the hierarchical select, with positioned recall pairs (the default) or
  with `positionedRecallPairs: false` and no `maxMessageTokens` cap, a summary
  at any level goes out as its messages, raw, where they cost no more than it
  does, a tie included, counting the stub result pairing repair gives a call
  of theirs that no result answers. It stays where that would part a tool
  round, lose a call that shares its id with a later call in its message, end
  the request with a call no result answers, or leave out one of its messages
  that is no longer in the store's view (a removal in legacy mode keeps the
  summary that folded the message, which then alone holds it). Pairing repair
  may move a raw result beside its call, leaving a placeholder where it was.
  So the request carries no more than those messages do, and a compile they
  fit is no longer refused (#407). In #407's probe, an L1 whose recall pair
  cost 933 tokens went out in place of four messages that cost 456, and
  budgets the request would have fit with those messages raw were refused.
  This holds for every strategy built on the autobiographical one,
  `KnowledgeStrategy` included, whose `[LEAD]` marks are its summarizer's
  reading of the same messages. Under a `maxMessageTokens` cap with positioned
  pairs, the messages go out as the cap cuts them. Under a cap with
  `positionedRecallPairs: false`, the combined answer is charged as the cap
  leaves it, and its summaries stay as selected. A store where a summary now
  goes out as its messages sends different requests from its first compile
  after the upgrade, so a provider's prompt cache serves them only up to where
  they first differ.
