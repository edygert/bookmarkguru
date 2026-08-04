#!/usr/bin/env python3
"""
Deletes every record on a named host from a BookmarkGuru backup.

    python3 scripts/drop-hosts.py <backup>.checked.json \
        oldvendor.example 'mirror.*' --report <backup>.report.csv

Prints what it would delete and writes nothing. Add `--write <path>` to produce the
pruned backup, which is what Restore then takes.

The companion to check-links.py. That one labels what is unreachable; this one acts on
the answer, for the case its per-record verdicts cannot reach: a whole host that is gone,
or was never reachable from here — a retired vendor site, a former employer's intranet, a
LAN name, a domain the resolver blocks. Those are decided per host by someone who knows
which is which, not per link by a fetch.

Two steps, because a restore is unrecoverable: the preview names the count and the hosts,
and only `--write` produces a file. The same shape as the sidebar's Replace library, whose
second click carries the count of what it destroys.

⚠️ Deleting records is the one thing here that a later run cannot undo. `Restore` calls
clearAll() and writes the file, so a record dropped from the file and then restored is
gone from the database. The backup you started from is the floor under that — keep it
until the restore is verified.

Reads a backup and writes a backup. It never modifies its input, never touches IndexedDB,
and makes no network request.
"""
from __future__ import annotations

import argparse
import collections
import csv
import fnmatch
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

FORMAT = "bookmarkguru-backup"


# ── matching ──────────────────────────────────────────────────────────────────


def host_of(url: str) -> str:
    """
    The host, without its port.

    A LAN bookmark carries one (`nas:9000`) and comparing it against a bare name silently
    matches nothing — the pattern looks wrong rather than the URL.
    """
    return urlsplit(url).netloc.split("@")[-1].split(":")[0].lower()


def matcher(pattern: str):
    """
    A pattern matches a host exactly or as a parent domain: `oldvendor.example` takes
    `www.oldvendor.example` with it, since a dead site is dead on every subdomain.

    A pattern containing `*` is a glob over the whole host instead, for the cases the
    suffix rule cannot state — one name across two TLDs (`mirror.*`), or a name that is a
    prefix of something longer, as a proxied host puts the original in front of its own.
    """
    clean = pattern.strip().lower()
    if "*" in clean:
        return lambda host: fnmatch.fnmatch(host, clean)
    return lambda host: host == clean or host.endswith("." + clean)


def read_patterns(args) -> list[str]:
    patterns = list(args.hosts)
    if args.hosts_file:
        for line in args.hosts_file.read_text(encoding="utf-8").splitlines():
            name = line.split("#", 1)[0].strip()
            if name:
                patterns.append(name)
    return patterns


# ── the backup ────────────────────────────────────────────────────────────────


def load_backup(path: Path) -> dict:
    """The identity checks Restore makes, so the wrong file costs a second, not a run."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"{path}: not a JSON file ({exc}).")
    except OSError as exc:
        sys.exit(f"{path}: {exc}")

    if not isinstance(payload, dict) or payload.get("format") != FORMAT:
        sys.exit(f"{path}: not a BookmarkGuru backup.")
    if not isinstance(payload.get("bookmarks"), list) or not isinstance(payload.get("tags"), list):
        sys.exit(f"{path}: backup is missing its bookmarks or tags.")
    return payload


def load_verdicts(path: Path | None) -> dict[str, str]:
    """URL → verdict, from a check-links report. Optional; absent means no verdicts."""
    if path is None:
        return {}
    try:
        with path.open(encoding="utf-8", newline="") as handle:
            return {row["url"]: row["verdict"] for row in csv.DictReader(handle)}
    except (OSError, KeyError) as exc:
        sys.exit(f"{path}: not a check-links report ({exc}).")


def validate_output(path: Path, source: dict, expected: int) -> None:
    """Read back what was written and hold it to the rules Restore applies."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        sys.exit(f"{path}: written, but could not be read back to check it ({exc}).")

    problems = []
    if payload.get("format") != FORMAT:
        problems.append("format marker")
    if payload.get("schemaVersion") != source.get("schemaVersion"):
        problems.append("schemaVersion")
    if not isinstance(payload.get("bookmarks"), list) or not isinstance(payload.get("tags"), list):
        problems.append("bookmarks/tags arrays")
    elif len(payload["bookmarks"]) != expected:
        problems.append(f"record count {len(payload['bookmarks'])} != {expected}")

    tag_ids = {tag.get("id") for tag in payload.get("tags", [])}
    orphans = {t for r in payload.get("bookmarks", []) for t in r.get("tags", []) if t not in tag_ids}
    if orphans:
        problems.append(f"{len(orphans)} tag id(s) with no tag record")

    if problems:
        sys.exit(f"{path}: written file would be refused by Restore — {', '.join(problems)}.")


# ── reporting ─────────────────────────────────────────────────────────────────


def preview(matched: dict[str, list[dict]], verdicts: dict[str, str]) -> None:
    """Per pattern: how many records, which hosts, and what the checker said about them."""
    width = max((len(p) for p in matched), default=8)
    print(f"{'pattern':<{width}}  {'recs':>5}  verdicts")
    for pattern, records in matched.items():
        if not records:
            print(f"{pattern:<{width}}  {0:>5}  — matched nothing")
            continue
        tally = collections.Counter(verdicts.get(r["url"], "not checked") for r in records)
        hosts = sorted({host_of(r["url"]) for r in records})
        print(f"{pattern:<{width}}  {len(records):>5}  {dict(tally)}")
        if len(hosts) > 1:
            print(f"{'':<{width}}         {', '.join(hosts)[:96]}")


def casualties(records: list[dict], verdicts: dict[str, str]) -> list[dict]:
    """Records that answered 2xx and would be deleted anyway."""
    return [r for r in records if verdicts.get(r["url"]) == "ok"]


# ── entry point ───────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Delete every record on a named host from a BookmarkGuru backup.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="A host pattern matches that host and its subdomains; one containing * is a\n"
               "glob over the whole host. Previews and writes nothing unless --write is given.",
    )
    parser.add_argument("backup", type=Path, help="a backup from the sidebar's Export, or a check-links output")
    parser.add_argument("hosts", nargs="*", help="host patterns, e.g. oldvendor.example 'mirror.*'")
    parser.add_argument("--hosts-file", type=Path, help="more patterns, one per line; # comments allowed")
    parser.add_argument("-r", "--report", type=Path, help="a check-links report, to show verdicts and guard live links")
    parser.add_argument("-w", "--write", type=Path, help="write the pruned backup here (without this, previews only)")
    parser.add_argument("--force", action="store_true", help="write even when a matched link came back ok")

    args = parser.parse_args(argv)
    if args.write is not None and args.write == args.backup:
        parser.error("--write would overwrite the input backup")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    patterns = read_patterns(args)
    if not patterns:
        sys.exit("No host patterns given. Pass them as arguments or with --hosts-file.")

    payload = load_backup(args.backup)
    verdicts = load_verdicts(args.report)
    records = payload["bookmarks"]

    tests = {pattern: matcher(pattern) for pattern in patterns}
    matched = {p: [r for r in records if test(host_of(r["url"]))] for p, test in tests.items()}
    doomed = [r for r in records if any(test(host_of(r["url"])) for test in tests.values())]

    preview(matched, verdicts)
    print(f"\n{len(doomed):,} of {len(records):,} records match {len(patterns)} pattern(s).")

    # A host list is written by hand, and the realistic mistake is a pattern wider than
    # intended. The checker already knows which of these answered; saying so here is the
    # last point at which a live link can be kept.
    live = casualties(doomed, verdicts)
    if live:
        print(f"\n⚠ {len(live)} of them came back ok:")
        for record in live[:20]:
            print(f"    {host_of(record['url']):<32} {record.get('title', '')[:56]}")
        if len(live) > 20:
            print(f"    … and {len(live) - 20} more.")
    elif not verdicts:
        print("\nNo --report given, so nothing checked whether any of these still respond.")

    if args.write is None:
        print("\nPreviewed only. Add --write <path> to produce the pruned backup.")
        return 0
    if live and not args.force:
        sys.exit(f"\nRefusing to write: {len(live)} matched link(s) came back ok. "
                 f"Narrow the patterns, or pass --force.")

    doomed_ids = {id(r) for r in doomed}
    payload["bookmarks"] = [r for r in records if id(r) not in doomed_ids]
    args.write.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    validate_output(args.write, payload, len(records) - len(doomed))

    used = collections.Counter(t for r in payload["bookmarks"] for t in r["tags"])
    unused = [t["name"] for t in payload["tags"] if used[t["id"]] == 0]

    print(f"\nremoved {len(doomed):,} · {len(records):,} -> {len(payload['bookmarks']):,} records "
          f"· wrote {args.write}")
    if unused:
        # Left in place: an unused tag is visible in the Tags view with a Delete on its
        # row, and which of them is still wanted is not a thing a host pattern knows.
        print(f"{len(unused)} tag(s) now on no record: {', '.join(unused[:12])}")
    print("Restore this file, and keep the backup you started from until that is verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
