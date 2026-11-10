- Every compression and merge request carries `compressionCacheTtl` (default
  `'1h'`), where before only a request with a recall-ladder seam did. A request
  with none went out with membrane's own system marker at the 5-minute
  default: every `compressionSourceOnly` L1, the source-only fallback request
  of an L1 under `compressionSourceOnlyFallback`, a store's first L1, a capped
  ladder with no head window, and a merge with no earlier summary before what
  it merges. A call more than five minutes after the last
  one then wrote tools and system to the cache again and read nothing. Now
  that marker lasts as long as the seams do. A call more than an hour after
  the last one pays the 1-hour write, twice the input price where the
  5-minute write was 1.25 times. `compressionCacheMarkers: false` still sends
  every request without markers or `cacheTtl`.
