# 041 — wp4 cycle plan (decision record + CI closeout for PR A and PR C)

**Continuity.** wp3 D (039): "next wp5 guards, then wp4 closeout". The goalplan cursor selects wp4 before wp5
(registration order; wp4 depends only on wp2/wp3). This cycle therefore covers the parts of wp4 that do not need
PR B: the Desktop PATH CLI decision record and exact-head CI for #6802 and #6807. PR B's CI and the final lane report
belong to the wp5 cycle that follows; criterion c-5 is met only after all three PRs are green.

Deliverables (B):
1. Finalize `040_path_cli_decision_closeout.md` with the outcome: decision unchanged (no Desktop PATH installer in this
   lane), evidence that PR A covers the CLI section of the desktop guide and PR C names the Desktop CLI in launcher
   failures; follow-up design kept as written.
2. CI: rerun only failed jobs of #6802 run 37873621613 (`macos 1/2` timed out in a `tests/ci-workflows` batch whose
   12 files all pass alone; no changed module is in that batch). If the rerun fails again in the same place, compare
   with dev's run; a real regression goes back to a fix in wp5's branch base (PR A).
3. Watch #6807 CI at its current head.

Check (C): both PRs' required checks green at their exact heads (`gh pr checks`), recorded with run ids.
Out of scope: merging, other lanes, PR B.

