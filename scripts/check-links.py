#!/usr/bin/env python3
"""
Checks every link in a BookmarkGuru backup and tags the dead ones `Unreachable`.

    python3 scripts/check-links.py bookmarkguru-2026-08-04.json

Needs `requests`; only to run this, not to build the extension.

The extension declares no `host_permissions` and makes no outbound request — see the
comment above `permissions` in manifest.config.ts. A link checker inside it would end
that, and the install prompt would start saying "read your data on all websites". So the
check runs out here instead, over a file, and the extension is unchanged.

The round trip:

    sidebar Export → bookmarkguru-<date>.json → this script → <name>.checked.json
                   → sidebar Restore

The JSON backup is the only input that can work. Adding a tag means editing records that
already exist, and only the backup carries ids, tags and statuses; Restore writes it back
verbatim. Chrome's exported HTML is an importer source, and re-import is additive — it
leaves existing records alone, so nothing it produced could attach a tag.

⚠️ Restore replaces the library: it calls clearAll() and writes the file. That is what
makes this work — the output is the whole library with the tag edits folded in — and it
is also the way to lose data. Anything saved between the export and the restore is not in
the file and does not survive. Export immediately before a run; keep the original until
the restore is verified.

Nothing here writes to the input file or to IndexedDB.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

try:
    import requests
except ImportError:  # pragma: no cover - environment guidance, not logic
    sys.exit("check-links needs `requests`:  pip install requests")


FORMAT = "bookmarkguru-backup"

# `tagIdFromName('Unreachable')` in src/core/ids.ts produces exactly this: the name
# lowercased with whitespace hyphenated, behind `tag:`. Hardcoded rather than rederived —
# an id generated in two languages is two places to drift.
TAG_ID = "tag:unreachable"
TAG_NAME = "Unreachable"

# The default `python-requests/2.x` is what most bot-walls match on. Sending a browser
# string is the single biggest reduction in live links reported as blocked.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

CONNECT_TIMEOUT = 10.0
# Two requests to one host never overlap, and consecutive ones are spaced by this. A
# library is dense in a few domains, and 16 threads landing on one host is what turns a
# working site into a 429.
HOST_INTERVAL = 0.4
RETRY_BACKOFF = 1.5

OK, DEAD, UNKNOWN, SKIPPED = "ok", "dead", "unknown", "skipped"

# A HEAD is trusted only for these. Every other status is confirmed with a GET: plenty of
# servers answer HEAD with 403, 405 or 500 and the same URL with 200.
HEAD_TRUSTED = frozenset({404, 410})


# ── verdicts ──────────────────────────────────────────────────────────────────


def classify(status: int | None, error: str | None) -> str:
    """
    The rule, in one place.

    `unknown` is a verdict rather than a shrug folded into `dead`. Cloudflare, Reddit and
    a long tail of sites answer a script-shaped request with 403 or 429 while the page
    loads perfectly in a browser; calling those dead marks live links for deletion, and
    the only way to find out is to open several hundred by hand. A missed dead link costs
    a re-run. Both classes reach the CSV either way, so --strict is a second pass over
    evidence rather than a guess.

    `dead` therefore means one of two things and no others: nothing answered at that
    address, or something answered that the page is gone (404, 410).

    **5xx is `unknown`, not `dead`.** It says the server is up and broken, which is not
    the same claim as the link being gone, and it is overwhelmingly transient: one sweep
    over a few thousand URLs will catch some host mid-deploy or mid-rate-limit, and a
    whole domain's worth of links gets condemned for a bad ten minutes. Observed while
    testing this script — httpbin.org answered 503 to every request for the duration.
    """
    if error is not None:
        return UNKNOWN if error == "redirect-loop" else DEAD
    if status is None:
        return UNKNOWN
    if 200 <= status < 300:
        return OK
    if status in (404, 410):
        return DEAD
    return UNKNOWN


def checkable(url: str) -> bool:
    """http and https only. A chrome:// or javascript: URL is not a claim about a server."""
    return urlsplit(url).scheme in ("http", "https")


# ── fetching ──────────────────────────────────────────────────────────────────


class HostGate:
    """Serializes requests per host and spaces them by HOST_INTERVAL."""

    def __init__(self, interval: float = HOST_INTERVAL) -> None:
        self._interval = interval
        self._guard = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        self._last: dict[str, float] = defaultdict(float)

    def _lock_for(self, host: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(host, threading.Lock())

    def __call__(self, host: str):
        gate = self
        lock = self._lock_for(host)

        class _Held:
            def __enter__(self) -> None:
                lock.acquire()
                wait = gate._last[host] + gate._interval - time.monotonic()
                if wait > 0:
                    time.sleep(wait)

            def __exit__(self, *_exc: object) -> None:
                gate._last[host] = time.monotonic()
                lock.release()

        return _Held()


def _brief(exc: Exception) -> str:
    """
    The innermost cause, in one line.

    A requests ConnectionError stringifies to the whole urllib3 chain — pool, retry count
    and the original message nested three deep — which is unreadable in a CSV cell.
    """
    cause: BaseException = exc
    while cause.__context__ is not None or cause.__cause__ is not None:
        cause = cause.__cause__ or cause.__context__
    text = " ".join(str(cause).split())
    return text[:120] if text else type(cause).__name__


def _request(session: requests.Session, method: str, url: str, timeout: float):
    """One attempt. Returns (status, final_url, error) — exactly one of status/error is set."""
    try:
        response = session.request(
            method,
            url,
            timeout=(CONNECT_TIMEOUT, timeout),
            allow_redirects=True,
            headers=HEADERS,
            stream=(method == "GET"),
        )
    except requests.exceptions.TooManyRedirects:
        return None, url, "redirect-loop"
    except requests.exceptions.SSLError as exc:
        return None, url, f"tls: {_brief(exc)}"
    except requests.exceptions.ConnectTimeout:
        return None, url, "connect timeout"
    except requests.exceptions.ReadTimeout:
        return None, url, "read timeout"
    except requests.exceptions.ConnectionError as exc:
        return None, url, f"connection: {_brief(exc)}"
    except requests.exceptions.MissingSchema:
        return None, url, "malformed URL"
    except requests.exceptions.InvalidURL:
        return None, url, "malformed URL"
    except requests.exceptions.RequestException as exc:
        return None, url, _brief(exc)

    try:
        return response.status_code, response.url, None
    finally:
        response.close()


def _transient(error: str | None) -> bool:
    return error is not None and (error.endswith("timeout") or error.startswith("connection:"))


def probe(session: requests.Session, url: str, timeout: float) -> dict:
    """
    HEAD, then GET unless the HEAD is one we trust, with one retry on a transport blip.

    A transient failure over several thousand URLs otherwise manufactures dead links, and
    a HEAD-only check reports working sites as broken.
    """
    status, final_url, error = _request(session, "HEAD", url, timeout)

    if error is None and status in HEAD_TRUSTED:
        return {"status": status, "final_url": final_url, "reason": None}
    if error is None and 200 <= status < 300:
        return {"status": status, "final_url": final_url, "reason": None}

    status, final_url, error = _request(session, "GET", url, timeout)
    if _transient(error):
        time.sleep(RETRY_BACKOFF)
        status, final_url, error = _request(session, "GET", url, timeout)

    return {"status": status, "final_url": final_url, "reason": error}


# ── backup file ───────────────────────────────────────────────────────────────


def load_backup(path: Path) -> dict:
    """
    The same identity checks parseBackup makes, and for the same reason: the realistic
    mistake is picking the wrong file, and it should cost a second rather than a run.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"{path}: not a JSON file ({exc}).")
    except OSError as exc:
        sys.exit(f"{path}: {exc}")

    if not isinstance(payload, dict) or payload.get("format") != FORMAT:
        sys.exit(f"{path}: not a BookmarkGuru backup. Use the sidebar's Export, not a .html export.")
    if not isinstance(payload.get("bookmarks"), list) or not isinstance(payload.get("tags"), list):
        sys.exit(f"{path}: backup is missing its bookmarks or tags.")
    return payload


def validate_output(path: Path, schema_version: object, expected_records: int) -> None:
    """
    Read back what was written and hold it to the rules Restore applies. A file Restore
    refuses is the one failure that wastes the whole run.
    """
    payload = json.loads(path.read_text(encoding="utf-8"))
    problems = []
    if payload.get("format") != FORMAT:
        problems.append("format marker")
    if payload.get("schemaVersion") != schema_version:
        problems.append("schemaVersion")
    if not isinstance(payload.get("bookmarks"), list) or not isinstance(payload.get("tags"), list):
        problems.append("bookmarks/tags arrays")
    elif len(payload["bookmarks"]) != expected_records:
        problems.append(f"record count {len(payload['bookmarks'])} != {expected_records}")
    if problems:
        sys.exit(f"{path}: written file would be refused by Restore — {', '.join(problems)}.")


# ── the run ───────────────────────────────────────────────────────────────────


def interleave(urls: list[str]) -> list[str]:
    """
    Round-robin the queue across hosts, so the first N tasks are N different servers
    rather than N threads queueing on one HostGate.
    """
    by_host: dict[str, list[str]] = defaultdict(list)
    for url in urls:
        by_host[urlsplit(url).netloc].append(url)

    queues = list(by_host.values())
    ordered = []
    while queues:
        queues = [q for q in queues if q]
        for queue in queues:
            ordered.append(queue.pop(0))
    return ordered


def check_all(urls: list[str], args, cached: dict[str, dict]) -> dict[str, dict]:
    """Fetch every URL not already decided, reporting progress on stderr."""
    results = {url: cached[url] for url in urls if url in cached}
    pending = interleave([url for url in urls if url not in results])
    if not pending:
        return results

    gate = HostGate()
    tally: dict[str, int] = defaultdict(int)
    for verdict in (results[url]["verdict"] for url in results):
        tally[verdict] += 1
    done = 0
    lock = threading.Lock()
    local = threading.local()

    def session() -> requests.Session:
        if not hasattr(local, "session"):
            local.session = requests.Session()
        return local.session

    def run(url: str) -> tuple[str, dict]:
        with gate(urlsplit(url).netloc):
            outcome = probe(session(), url, args.timeout)
        outcome["verdict"] = classify(outcome["status"], outcome["reason"])
        return url, outcome

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for url, outcome in pool.map(run, pending):
                results[url] = outcome
                with lock:
                    done += 1
                    tally[outcome["verdict"]] += 1
                    if done % 10 == 0 or done == len(pending):
                        report_progress(done, len(pending), tally)
                        save_resume(args.resume, results)
    except KeyboardInterrupt:
        save_resume(args.resume, results)
        print(
            f"\ninterrupted after {done} of {len(pending)}."
            + (f" Re-run with --resume {args.resume} to continue." if args.resume else ""),
            file=sys.stderr,
        )
        sys.exit(130)
    finally:
        print(file=sys.stderr)

    return results


def report_progress(done: int, total: int, tally: dict[str, int]) -> None:
    counts = " · ".join(f"{tally[v]} {v}" for v in (OK, DEAD, UNKNOWN) if tally[v])
    print(f"\r  {done:,} / {total:,}   {counts}   ", end="", file=sys.stderr, flush=True)


def save_resume(path: Path | None, results: dict[str, dict]) -> None:
    if path is None:
        return
    path.write_text(json.dumps(results), encoding="utf-8")


def load_resume(path: Path | None) -> dict[str, dict]:
    if path is None or not path.exists():
        return {}
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return cached if isinstance(cached, dict) else {}


# ── applying verdicts ─────────────────────────────────────────────────────────


def apply_verdicts(payload: dict, verdicts: dict[str, str], args) -> tuple[int, int]:
    """
    Write the verdict onto the records. Returns (tagged, untagged).

    `updatedAt` moves only where `tags` actually changed, matching retag() in
    src/core/tags.ts; every other record comes out byte-identical. `url`, `normalizedUrl`
    and `domain` are never rewritten, redirect or not — the final URL belongs in the CSV.

    The tag comes off on `ok` and on nothing else, so --strict is close to one-way: a link
    tagged for a 403 classifies `unknown` again next run, and a non-strict run leaves it
    as found rather than clearing it.
    """
    now = int(time.time() * 1000)
    tag_dead = {DEAD, UNKNOWN} if args.strict else {DEAD}
    tagged = untagged = 0

    for record in payload["bookmarks"]:
        verdict = verdicts.get(record.get("url", ""))
        # A record the run did not reach, and a `skipped` one, keep whatever tag they had:
        # no evidence was gathered, and clearing on none is the same error as tagging on none.
        if verdict is None or verdict == SKIPPED:
            continue

        tags = record.get("tags") or []
        has = TAG_ID in tags

        if verdict in tag_dead and not has:
            record["tags"] = [*tags, TAG_ID]
            record["updatedAt"] = now
            tagged += 1
        elif verdict == OK and has and not args.keep:
            record["tags"] = [t for t in tags if t != TAG_ID]
            record["updatedAt"] = now
            untagged += 1

    # Without the tag record the id on those bookmarks matches nothing: the chip renders
    # as blank and the Tags view cannot reach it. Present already means present — the id
    # is the identity, and a rename of it is the user's.
    if tagged and not any(tag.get("id") == TAG_ID for tag in payload["tags"]):
        payload["tags"].append({"id": TAG_ID, "name": TAG_NAME})

    return tagged, untagged


def suspect_hosts(results: dict[str, dict], threshold: int = 3) -> list[tuple[str, int]]:
    """
    Hosts where several URLs were fetched and not one came back ok.

    One link on a host failing is a dead link; every link on a host failing is usually the
    host, and the difference does not show up per-record. Reported before the summary so
    an outage is caught while the original export is still the library, rather than after
    a restore has tagged a working domain.
    """
    per_host: dict[str, list[str]] = defaultdict(list)
    for url, outcome in results.items():
        per_host[urlsplit(url).netloc].append(outcome["verdict"])

    flagged = [
        (host, len(verdicts))
        for host, verdicts in per_host.items()
        if len(verdicts) >= threshold and OK not in verdicts
    ]
    return sorted(flagged, key=lambda pair: -pair[1])


def write_report(path: Path, payload: dict, results: dict[str, dict], verdicts: dict[str, str]) -> None:
    """One row per record — the id and title are what make a verdict actionable."""
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["verdict", "http_status", "reason", "url", "final_url", "title", "status", "id"]
        )
        for record in payload["bookmarks"]:
            url = record.get("url", "")
            verdict = verdicts.get(url)
            if verdict is None:
                continue
            outcome = results.get(url, {})
            writer.writerow([
                verdict,
                outcome.get("status") or "",
                outcome.get("reason") or "",
                url,
                outcome.get("final_url") or "",
                record.get("title", ""),
                record.get("status", ""),
                record.get("id", ""),
            ])


# ── entry point ───────────────────────────────────────────────────────────────


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check every link in a BookmarkGuru backup; tag the dead ones Unreachable.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Restore the output with the sidebar's Restore button. It replaces the "
               "library, so do not use the extension between exporting and restoring.",
    )
    parser.add_argument("backup", type=Path, help="a bookmarkguru-<date>.json from the sidebar's Export")
    parser.add_argument("-o", "--out", type=Path, help="output backup (default: <input>.checked.json)")
    parser.add_argument("-r", "--report", type=Path, help="CSV of every verdict (default: <input>.report.csv)")
    parser.add_argument("--resume", type=Path, help="verdict cache; reuse and update, so an interrupted run continues")
    parser.add_argument("-j", "--workers", type=int, default=16, help="concurrent requests (default 16)")
    parser.add_argument("--timeout", type=float, default=15.0, help="per-request read timeout in seconds (default 15)")
    parser.add_argument("--limit", type=int, help="check only the first N records — for a trial run")
    parser.add_argument("--strict", action="store_true",
                        help="also tag `unknown` verdicts (401/403/429/5xx). Near one-way: "
                             "a later run without it does not clear them")
    parser.add_argument("--keep", action="store_true", help="do not remove the tag from links that now respond")

    args = parser.parse_args(argv)
    stem = args.backup.with_suffix("")
    if args.out is None:
        args.out = Path(f"{stem}.checked.json")
    if args.report is None:
        args.report = Path(f"{stem}.report.csv")
    if args.out == args.backup:
        parser.error("--out would overwrite the input backup")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    payload = load_backup(args.backup)
    records = payload["bookmarks"]

    considered = records[: args.limit] if args.limit else records
    urls = list(dict.fromkeys(r.get("url", "") for r in considered if r.get("url")))
    to_check = [u for u in urls if checkable(u)]
    skipped_urls = {u for u in urls if not checkable(u)}

    cached = load_resume(args.resume)
    reused = sum(1 for url in to_check if url in cached)

    print(
        f"{len(records):,} records · {len(to_check) - reused:,} URLs to fetch"
        + (f" · {reused:,} already decided (--resume)" if reused else "")
        + (f" · limited to the first {args.limit:,} records" if args.limit else ""),
        file=sys.stderr,
    )

    results = check_all(to_check, args, cached)

    verdicts = {url: results[url]["verdict"] for url in results}
    verdicts.update({url: SKIPPED for url in skipped_urls})

    tagged, untagged = apply_verdicts(payload, verdicts, args)
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    validate_output(args.out, payload.get("schemaVersion"), len(records))
    write_report(args.report, payload, results, verdicts)

    tally: dict[str, int] = defaultdict(int)
    for verdict in verdicts.values():
        tally[verdict] += 1

    flagged = suspect_hosts(results)
    if flagged:
        print(
            f"\n⚠ {len(flagged)} host(s) had no URL come back ok — check for an outage "
            f"before restoring:",
            file=sys.stderr,
        )
        for host, count in flagged[:15]:
            print(f"    {host}  ({count} URLs)", file=sys.stderr)
        if len(flagged) > 15:
            print(f"    … and {len(flagged) - 15} more; the CSV has all of them.", file=sys.stderr)
        print(file=sys.stderr)

    # Distinct URLs, and the four verdicts sum to it — `skipped` ones were never fetched,
    # so counting them against "URLs fetched" would print a total that does not add up.
    print(
        f"{len(records):,} records · {len(urls):,} URLs · "
        f"{tally[OK]:,} ok · {tally[DEAD]:,} dead · {tally[UNKNOWN]:,} unknown · "
        f"{tally[SKIPPED]:,} skipped"
    )
    # Records, not URLs: several records can share a URL, so this is a different
    # denominator from the line above and says so.
    noun = "record" if tagged == 1 else "records"
    print(f"tagged {tagged:,} {noun} · untagged {untagged:,} · wrote {args.out}")
    print(f"verdicts per record: {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
