# Updating this fork from upstream

Upstream improvements belong in the customized fork as well as its tracking
branch. A clean Git merge establishes textual compatibility only. The combined
code must still preserve the fork's behavior, tests, interfaces and evidence.

Use this prompt for a future update. Branch names and open PRs must be discovered
again, because they can change after this document was written.

## Reusable prompt

> Safely synchronize my fork, https://github.com/Y0UW1SH/rea, with the latest
> `main` from https://github.com/morluto/rea while preserving all our fork-specific
> features.
>
> Read the repository's contribution instructions and SaaS change ledger. Inspect
> the actual default branch, fork `main`, customized branches and open PR
> dependencies. Fetch and record the exact source commit SHAs and preserve
> recoverable checkpoints before making changes.
>
> Create an isolated integration branch from the current customized branch and
> merge the selected upstream commit into it. Preserve both upstream improvements
> and our additions. Never reset our branch to upstream, force-push, blindly accept
> one side of conflicts, or drop features or tests to make the merge pass. Keep
> unfinished feature PRs separate; rehearse their combinations where they overlap.
>
> Review semantic compatibility even where Git reports no conflict. Check the
> feature inventory, CLI/MCP contracts, evidence and authority boundaries, browser
> lifecycle, replay behavior, installed skill content, dependencies and CI job
> policies. Do not activate workflows or change repository settings as a shortcut.
>
> Use the repository-pinned toolchain and locked dependencies. Run the required
> integration gates, SaaS regressions, affected CLI/MCP and browser tests, build,
> static checks and documentation checks on the exact combined tree. Add focused
> regressions for integration bugs. Compare failures with the starting fork and
> upstream where needed; distinguish new regressions, existing failures and
> environment limitations. Do not weaken assertions or omit failing checks.
> Confirm that CI actually selects the PR's base branch and tested revision;
> absent or skipped checks are unverified, not passing.
>
> Fix demonstrated regressions and open a draft integration PR. Report the exact
> upstream SHA and tested tree, retained fork features, conflict resolutions,
> commands and results, remaining proof gaps, affected dependent PRs and rollback
> checkpoint. Passing tests must not be described as proof that no bugs exist.
>
> Leave shared branches unchanged until I approve the concrete result. After
> approval, recheck the source heads and use normal merges or fast-forwards to
> apply the tested update to the appropriate fork branches. If the sources have
> moved, refresh and revalidate the affected combination first. Do not merge
> unrelated draft features as part of the sync.

## What a successful sync establishes

The integration retains the selected upstream commit in its ancestry and passes
the recorded checks with the fork's additions present. It does not establish live
vendor compatibility, coverage on untested platforms, or compatibility with a
later upstream revision. The integration PR should link its exact validation
receipt and identify any pending PRs that still need conflict resolution.

The fork's `main` may be an upstream-tracking branch while a different default
branch contains the customized product. Updating only the tracking branch does
not update the customized product. Inspect that relationship on each run.

See the [2026-10-21 integration receipt](saas-upstream-sync-validation.md) for a
worked example, including conflicts, passing checks and unresolved failures.
