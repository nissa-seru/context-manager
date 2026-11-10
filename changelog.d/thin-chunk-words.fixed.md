- A chunk the thin-chunk guard stores without a model call (text only, with
  less trimmed text than `minChunkCharsForLLM`, 200 characters by default)
  now keeps its own words as its L1: one `participant: text` line per message
  with text, the name left off where the text already begins with it, or
  `(1 message, none with text.)` / `(N messages, none with text.)` when none
  has any. Before, every such chunk was stored as "(A quiet stretch: N
  messages of routine system traffic — heartbeats, empty turns, notices.
  Nothing happened worth remembering.)", whatever it said. So a short
  instruction the chunker closed alone at a seam (a pin, a system change, the
  head window or an earlier chunk record) was remembered as nothing having
  happened, and later chunks' L1 requests recalled it so. The L1's `tokens` is
  now the strategy's estimate of its content, where it was 40 whatever it held.
- Opening a store rewrites, once, each L1 that holds that old text exactly and
  whose messages the store still holds, to those messages' words, with one
  `[autobiographical] rewrote N quiet-stretch stub(s) as the words of the
  messages they cover` warning. A stub whose messages have left the store
  stays as it is, and so does what was already written from one: a later
  chunk's L1 that recalled it, or an L3 merge, which reads L1s. An
  audit-only open rewrites nothing.
