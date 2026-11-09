- **`PassthroughStrategy` and `WindowedPassthroughStrategy` refuse a message
  larger than the room, rather than leave it and everything before it out.**
  When a compile's walk back from the newest message stops at a message
  larger than the room the budget leaves, less the system changes, a
  committing compile now throws `OverBudgetError` naming it: its id, its
  participant, and what clears it (removing or editing it, a larger budget,
  and under the windowed strategy `maxMessageTokens`). Before, that message
  and every message before it were left out with no sign: under
  `PassthroughStrategy` for as long as it was stored, with nothing sent while
  it was the newest message unless system changes made the compile refuse,
  and under `WindowedPassthroughStrategy` from the first compile after a
  newer message that fit, past any later budget, since the anchor moved past
  it. Newer conversation that alone overflows the room (under the windowed
  strategy, its re-anchor share of it) moves the window past such a message,
  as past any old message, where before one newer message that fit did;
  `OverBudgetError.clearedBy`'s `'newer-message'` now says so. A dry compile
  still reports the window instead of throwing. A budget that leaves no room
  after the response reserve is refused too, as the budget's own failure
  ("the budget leaves no room after the response reserve", `clearedBy`
  empty), where `PassthroughStrategy` sent nothing and
  `WindowedPassthroughStrategy` named the newest message. Unchanged: the
  refusals when the system changes leave no room. An anchor an earlier
  release moved past such a message stays where it is; `setAnchor` moves it
  back.
