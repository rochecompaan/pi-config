"""Run with python3 -m maintenance.dependency_updates."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .candidate import git, prepare, read_report, validate, write_report
from .model import UpdateError, audit_sources, load_catalog


def _output(changed: bool) -> None:
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a") as output:
            output.write(f"changed={str(changed).lower()}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare and validate scoped dependency updates")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    commands.add_parser("audit")
    preparation = commands.add_parser("prepare")
    preparation.add_argument("unit")
    preparation.add_argument("--base", required=True)
    preparation.add_argument("--base-sha", required=True)
    preparation.add_argument("--report", type=Path, required=True)
    preparation.add_argument("--dry-run", action="store_true")
    validation = commands.add_parser("validate")
    validation.add_argument("--report", type=Path, required=True)
    publication = commands.add_parser("publish")
    publication.add_argument("--report", type=Path, required=True)
    publication.add_argument("--server", required=True)
    publication.add_argument("--repository", required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    report = getattr(args, "report", None)
    candidate = None
    try:
        if report is not None:
            report = report.resolve()
            if report.is_relative_to(root):
                raise UpdateError("inventory", "Candidate report must be outside the checkout")
        units, policies = load_catalog(root)
        if args.command == "list":
            print(json.dumps(sorted(units), separators=(",", ":")))
        elif args.command == "audit":
            audit_sources(root, policies)
            print(f"Inventory valid: {len(units)} units, {len(policies)} fixed sources")
        elif args.command == "prepare":
            if args.unit not in units:
                raise UpdateError("inventory", "Unknown update unit")
            if args.dry_run:
                with tempfile.TemporaryDirectory(prefix="dependency-dry-run-") as directory:
                    clone = Path(directory) / "repo"
                    git(root, "clone", "--quiet", "--no-hardlinks", str(root), str(clone))
                    git(clone, "checkout", "--quiet", "--detach", args.base_sha)
                    candidate = prepare(clone, units[args.unit], args.base, args.base_sha)
            else:
                candidate = prepare(root, units[args.unit], args.base, args.base_sha)
            write_report(report, candidate)
            _output(candidate.changed)
            print(candidate.summary)
        elif args.command == "validate":
            candidate = read_report(report)
            if candidate.unit_id not in units:
                raise UpdateError("inventory", "Report references an unknown update unit")
            candidate = validate(root, units[candidate.unit_id], candidate)
            write_report(report, candidate)
            print("Validation passed" if candidate.validated else "No changes; no validation required")
        elif args.command == "publish":
            from .forgejo_api import ForgejoClient
            from .publish import publish
            candidate = read_report(report)
            token = os.environ.get("DEPENDENCY_UPDATE_TOKEN")
            if not token:
                raise UpdateError("publication", "DEPENDENCY_UPDATE_TOKEN is required")
            client = ForgejoClient(args.server, args.repository, token)
            print(publish(root, candidate, client, subprocess.run))
        return 0
    except UpdateError as error:
        if report is not None and not report.is_relative_to(root):
            write_report(report, candidate, error)
        if args.command == "prepare":
            _output(False)
        print(f"{error.stage}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
