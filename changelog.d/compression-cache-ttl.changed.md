- `AutobiographicalStrategy.applyMintCacheSeams`' doc said "callers attach
  `cacheTtl` only then, so every marker-less request (kill switch, capped
  ladder with no head window, no ladder yet) keeps the exact pre-seam request
  shape and its canonical hash / quarantine identity". Now only the kill
  switch, `compressionCacheMarkers: false`, sends the pre-seam request. So at
  upgrade, a quarantined chunk whose request carried no `cacheTtl` calls its
  provider once more, since its request hash changed, and twice under
  `compressionSourceOnlyFallback`: the canonical request, then the fallback.
  Without the fallback, a chunk the three-shape cap stopped stays stopped. A
  merge's quarantine, keyed by its sources, stays as it is.
