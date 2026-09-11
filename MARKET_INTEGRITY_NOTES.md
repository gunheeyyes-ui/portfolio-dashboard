# Market integrity semantics

- Raw Strategy OOS and Shadow Auto history are never rewritten or deleted.
- Signal-time/pre-open KIS market status snapshots can block only future Shadow Auto entries.
- Hard historical price discontinuities are quarantined only in the separate comparable view.
- A later discontinuity never retroactively cancels an earlier horizon or historical order.
- Ranking V2, Leader, RS20, timing, Scout, strategy registry, Strategy OOS and Ranking OOS formulas remain unchanged.
