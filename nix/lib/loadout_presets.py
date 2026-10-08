"""Build loadout files from Pi's loaded resources and declarative suite choices."""

import argparse
import json
from pathlib import Path


def collect_catalog(resources, toolset, suite_roots):
    files = resources["skillFiles"]
    skills = sorted(set(resources["skills"]))
    suites = {}
    for suite, root in suite_roots.items():
        suites[suite] = [
            name for name in skills
            if name in files and Path(files[name]).is_relative_to(Path(root))
        ]
        if not suites[suite]:
            raise ValueError(f"No loaded skills found for suite: {suite}")
    # pi-loadout manages its codemode helper itself; it is not a user tool.
    tools = set(toolset["all"]) - {"pi_loadout_codemode_only"}
    result = {"tools": sorted(tools), "skills": skills, "suites": suites}
    if "manualSkills" in resources:
        result["manualSkills"] = sorted(set(resources["manualSkills"]))
    return result


def render_loadouts(catalog, config):
    tools = sorted(set(catalog["tools"]))
    if not tools:
        raise ValueError("Pi catalog has no tools")
    skills = set(catalog["skills"])
    suites = {name: set(names) for name, names in catalog["suites"].items()}
    shared = skills - set().union(*suites.values())
    profiles = {}
    for name, selection in config["profiles"].items():
        requested_suites = set(selection.get("suites", []))
        unknown = requested_suites - suites.keys()
        if unknown:
            raise ValueError(f"Unknown suites in {name}: {', '.join(sorted(unknown))}")
        selected = shared | set(selection.get("extraSkills", []))
        for suite in requested_suites:
            selected |= suites[suite]
        missing = selected - skills
        if missing:
            raise ValueError(f"Unknown skills in {name}: {', '.join(sorted(missing))}")
        profiles[name] = {
            "enabledTools": tools,
            "enabledSkills": sorted(selected),
            "updatedAt": config.get("updatedAt", "1970-01-01T00:00:00.000Z"),
        }
    default_name = config["defaultProfile"]
    if default_name not in profiles:
        raise ValueError(f"Unknown default profile: {default_name}")
    default = profiles[default_name]
    return {
        "loadout-profiles.json": {"defaultProfile": default_name, "profiles": profiles},
        "loadout.json": {
            "enabledTools": default["enabledTools"],
            "enabledSkills": default["enabledSkills"],
            "profileName": default_name,
        },
    }


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    catalog = commands.add_parser("catalog")
    for argument in ("resources", "tools", "suites"):
        catalog.add_argument(argument)
    render = commands.add_parser("render")
    for argument in ("catalog", "config", "output"):
        render.add_argument(argument)
    args = parser.parse_args()
    try:
        if args.command == "catalog":
            result = collect_catalog(
                read_json(args.resources), read_json(args.tools), read_json(args.suites),
            )
            print(json.dumps(result, indent=2, sort_keys=True))
        else:
            files = render_loadouts(read_json(args.catalog), read_json(args.config))
            output = Path(args.output)
            output.mkdir(parents=True, exist_ok=True)
            for name, value in files.items():
                (output / name).write_text(
                    json.dumps(value, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
    except ValueError as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
