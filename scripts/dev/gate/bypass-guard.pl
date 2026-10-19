#!/usr/bin/perl
# PreToolUse hook for Bash (wired in .claude/settings.json). Blocks a bare
# `tsc` or `next build`, which stack multi-GB processes outside the machine-wide
# gate (scripts/dev/gate). Exit 2 + stderr = Claude Code feeds the message to the
# model; exit 0 = allow. Any parse problem allows: never block on a guard bug.
# Core modules only; it runs before every Bash call, so startup stays ~10 ms.
#
# Known gaps (deliberate, a guard not a jail):
#  - `bash -c "tsc ..."`: quoted text is stripped so `grep "tsc -p"` and commit
#    messages do not trigger, which also hides quoted commands.
#  - a gate marker anywhere in the command allows the whole command.
#  - `npx tsc --init` and other tsc runs that compile nothing stay blocked.
#  - a wrapper this file does not know (`bunx`, a custom script) is not seen.
# `pnpm -r exec tsc` is blocked: it starts one tsc per package.
use strict;
use warnings;
use JSON::PP ();

my $raw = do { local $/; <STDIN> };
exit 0 unless defined $raw && length $raw;
my $data = eval { JSON::PP->new->decode($raw) };
exit 0 if $@ || ref($data) ne 'HASH';
my $in  = $data->{tool_input};
my $cmd = ref($in) eq 'HASH' ? $in->{command} : undef;
exit 0 unless defined $cmd && !ref($cmd) && length $cmd;

# Gated, or deliberately ungated.
exit 0 if $cmd =~ m{scripts/dev/gate/run\.mjs|with-gate-lock\.sh|with-gate\.mjs|(?:^|[\s;&|(])GATE_LOCK=0(?:\s|$)};

# Strip heredoc bodies, then quoted strings.
my $s = $cmd;
$s =~ s{<<-?\s*(['"]?)(\w+)\1[^\n]*\n.*?^\s*\2[ \t]*$}{}msg;
$s =~ s{'[^']*'}{''}sg;
$s =~ s{"(?:[^"\\]|\\.)*"}{""}sg;

my $wrap = qr{(?:
    (?:exec|sudo|nohup|do|then|else|!)\s+
  | time(?:\s+-p)?\s+
  | (?:pnpm|npm|yarn|npx|bunx)(?:\s+-\S+(?:\s+(?!exec\b|dlx\b|tsc\b)[^-\s]\S*)?)*\s+(?:(?:exec|dlx)\s+)?
  | node(?:\s+-\S+)*\s+
  | timeout\s+\S+\s+
  | env\s+(?:\w+=\S*\s+)*
  | \w+=\S*\s+
)*}x;
my $safe = qr{(?:^|\s)(?:--version|-v|--help|-h|--showConfig|--watch|-w)(?:\s|$)};

# Redirections are not command separators: neutralise 2>&1, >&2, &> before
# splitting on a single &.
$s =~ s{\d*>&\d*|&>>?}{ }g;

my $kind;
for my $seg (split /[;&|\n(]/, $s) {
    next unless $seg =~ m{^\s*$wrap(?:\S*/)?(tsc|next\s+build)(?=\s|$)(.*)$}s;
    my ($what, $rest) = ($1, $2);
    next if $what eq 'tsc' && $rest =~ $safe;
    $kind = $what eq 'tsc' ? 'tsc' : 'next';
    last;
}
exit 0 unless $kind;

if ($kind eq 'tsc') {
    print STDERR "Ungated tsc: ~20 sessions share this Mac and a bare tsc stacks with theirs (apps/web alone is several GB). Use pnpm typecheck (packages) or pnpm typecheck:<api|web|jobs|mobile|scanner>, or wrap any command: node scripts/dev/gate/run.mjs --weight heavy -- <cmd>. In a worktree, run that from the worktree root. GATE_LOCK=0 skips the gate deliberately.\n";
} else {
    print STDERR "Ungated next build: ~20 sessions share this Mac and a bare next build stacks with theirs. Use pnpm -F web build, or wrap any command: node scripts/dev/gate/run.mjs --weight heavy -- <cmd>. In a worktree, run that from the worktree root. GATE_LOCK=0 skips the gate deliberately.\n";
}
exit 2;
