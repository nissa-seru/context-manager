- On the hierarchical select, with positioned recall pairs (the default) or
  with `positionedRecallPairs: false` and no `maxMessageTokens` cap, a summary
  at any level goes out as its messages, raw, where they cost no more than it
  does, a tie included, unless that would part a tool round, lose a call that
  shares its id with a later call in its message, or one of its messages is
  no longer in the store's view (a removal in legacy mode keeps
  the summary that folded the message, which then alone holds it). So the
  request carries no more than those messages do, and a compile they fit is
  no longer refused (#407). In #407's probe, an L1 whose recall pair cost 933
  tokens went out in place of four messages that cost 456, and budgets the
  request would have fit with those messages raw were refused. Under a
  `maxMessageTokens` cap with `positionedRecallPairs: false`, the combined
  answer is charged as the cap leaves it, and its summaries stay as selected.
