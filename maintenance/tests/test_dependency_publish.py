import dataclasses
import io
import json
import subprocess
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest.mock import Mock

from maintenance.tests import test_dependency_candidate as candidate_fixtures
from maintenance.dependency_updates.candidate import validate
from maintenance.dependency_updates.model import Candidate, UpdateError
from maintenance.dependency_updates.forgejo_api import ForgejoClient
from maintenance.dependency_updates.publish import bot_branch, publish

SERVER = "https://forgejo.example"
REPOSITORY = "owner/repo"
TOKEN = "test-secret-never-log"


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(json.dumps(body).encode())
        self.status = status
        self.headers = headers or {}


class HTTPBoundary:
    def __init__(self):
        self.pulls = []
        self.requests = []
        self.fail_create = False
        self.redirect = False

    def __call__(self, request, timeout):
        self.requests.append(request)
        path = urllib.parse.urlsplit(request.full_url).path
        method = request.get_method()
        if self.redirect:
            return Response({}, 302, {"Location": "https://secret@evil.example"})
        if path.endswith("/user"):
            return Response({"id": 7, "login": "dependency-bot"})
        if method == "GET":
            page = int(urllib.parse.parse_qs(urllib.parse.urlsplit(request.full_url).query)["page"][0])
            return Response(self.pulls[(page-1)*50:page*50])
        if method == "POST":
            if self.fail_create:
                raise urllib.error.HTTPError(request.full_url, 403, TOKEN, {}, None)
            data = json.loads(request.data)
            pull = self.pull(len(self.pulls) + 1, data["head"], **data)
            self.pulls.append(pull)
            return Response(pull, 201)
        if method == "PATCH":
            number = int(path.rsplit("/", 1)[1])
            pull = next(p for p in self.pulls if p["number"] == number)
            pull.update(json.loads(request.data))
            return Response(pull)
        raise AssertionError((method, path))

    def pull(self, number, branch, **data):
        return {"number": number, "html_url": f"{SERVER}/{REPOSITORY}/pulls/{number}",
            "user": {"id": 7, "login": "dependency-bot"},
            "head": {"ref": branch, "repo": {"full_name": REPOSITORY}},
            "base": {"ref": "main", "repo": {"full_name": REPOSITORY}},
            "title": data.get("title", "old title"), "body": data.get("body", "old body")}


class PublicationGateTests(unittest.TestCase):
    def test_unvalidated_candidate_never_calls_api_or_git(self):
        candidate = Candidate("one", "main", "a" * 40, "b" * 40,
            ("nix/dependency-pins.json",), "Update", True)
        client, runner = Mock(), Mock()
        with self.assertRaises(UpdateError):
            publish(Path.cwd(), candidate, client, runner)
        self.assertEqual(client.mock_calls, [])
        runner.assert_not_called()

    def test_no_change_candidate_is_a_noop(self):
        candidate = Candidate("one", "main", "a" * 40, "b" * 40, (), "No changes", False)
        client, runner = Mock(), Mock()
        self.assertIsNone(publish(Path.cwd(), candidate, client, runner))
        self.assertEqual(client.mock_calls, [])
        runner.assert_not_called()

    def test_branch_identifier_cannot_inject_a_refspec(self):
        with self.assertRaises(UpdateError):
            bot_branch("one:main")


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = candidate_fixtures.CandidateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.remote = self.fixture.workspace / "remote.git"
        self.fixture.git("clone", "--quiet", "--bare", str(self.root), str(self.remote))
        self.url = SERVER + "/" + REPOSITORY + ".git"
        self.fixture.git("remote", "add", "origin", self.url)
        self.fixture.git("config", f"url.{self.remote}.insteadOf", self.url)
        self.boundary = HTTPBoundary()
        self.client = ForgejoClient(SERVER, REPOSITORY, TOKEN, self.boundary)
        prepared = self.fixture.make_candidate()
        self.candidate = validate(self.root, self.fixture.units["one"], prepared, self.fixture.runner)
        self.helpers = []
        self.git_commands = []

    def runner(self, command, **kwargs):
        self.git_commands.append(command)
        self.assertFalse(any(TOKEN in arg for arg in command))
        if helper := kwargs.get("env", {}).get("GIT_ASKPASS"):
            self.assertTrue(Path(helper).exists())
            self.helpers.append(Path(helper))
        return subprocess.run(command, **kwargs)

    def bare(self, *args):
        return subprocess.run(["git", "--git-dir", str(self.remote), *args],
            capture_output=True, text=True, check=True).stdout.strip()

    def branch_sha(self):
        return self.bare("rev-parse", "refs/heads/" + bot_branch("one"))

    def test_first_publication_pushes_exact_tree_and_creates_one_pull(self):
        url = publish(self.root, self.candidate, self.client, self.runner)
        sha = self.branch_sha()
        self.assertEqual(url, SERVER + "/owner/repo/pulls/1")
        self.assertEqual(self.bare("show", "-s", "--format=%T", sha), self.candidate.tree_sha)
        self.assertEqual(self.bare("show", "-s", "--format=%P", sha), self.candidate.base_sha)
        self.assertEqual(len(self.boundary.pulls), 1)
        self.assertTrue(self.helpers)
        self.assertTrue(all(not helper.exists() for helper in self.helpers))
        self.assertFalse(any("--force" in command for command in self.git_commands))

    def test_same_tree_and_pull_are_reused_without_rewrite(self):
        publish(self.root, self.candidate, self.client, self.runner)
        first = self.branch_sha()
        self.git_commands.clear()
        self.boundary.requests.clear()
        publish(self.root, self.candidate, self.client, self.runner)
        self.assertEqual(self.branch_sha(), first)
        self.assertFalse(any(command[:2] == ["git", "push"] for command in self.git_commands))
        self.assertFalse(any(r.get_method() in {"POST", "PATCH"} for r in self.boundary.requests))

    def test_paginated_pull_is_reused(self):
        self.boundary.pulls = [self.boundary.pull(i+1, f"unrelated-{i}") for i in range(50)]
        self.boundary.pulls.append(self.boundary.pull(51, bot_branch("one")))
        url = publish(self.root, self.candidate, self.client, self.runner)
        self.assertEqual(url, SERVER + "/owner/repo/pulls/51")
        self.assertEqual(len(self.boundary.pulls), 51)
        self.assertTrue(any("page=2" in r.full_url for r in self.boundary.requests))

    def test_api_failure_leaves_owned_orphan_reusable_and_helper_removed(self):
        self.boundary.fail_create = True
        with self.assertRaises(UpdateError) as raised:
            publish(self.root, self.candidate, self.client, self.runner)
        self.assertNotIn(TOKEN, str(raised.exception))
        first = self.branch_sha()
        self.assertTrue(all(not helper.exists() for helper in self.helpers))
        self.boundary.fail_create = False
        publish(self.root, self.candidate, self.client, self.runner)
        self.assertEqual(self.branch_sha(), first)
        self.assertEqual(len(self.boundary.pulls), 1)

    def test_human_owned_branch_is_not_overwritten(self):
        sha = self.fixture.git("commit-tree", self.candidate.tree_sha, "-p", self.candidate.base_sha, "-m", "Human changes")
        self.fixture.git("push", "--quiet", "origin", sha + ":refs/heads/" + bot_branch("one"))
        with self.assertRaises(UpdateError):
            publish(self.root, self.candidate, self.client, self.runner)
        self.assertEqual(self.branch_sha(), sha)
        self.assertEqual(self.boundary.pulls, [])

    def test_stale_default_head_blocks_publication(self):
        sha = self.fixture.git("commit-tree", self.candidate.tree_sha, "-p", self.candidate.base_sha, "-m", "Advance main")
        self.fixture.git("push", "--quiet", "origin", sha + ":refs/heads/main")
        with self.assertRaises(UpdateError):
            publish(self.root, self.candidate, self.client, self.runner)
        self.assertEqual(self.boundary.pulls, [])

    def test_duplicate_pulls_block_push(self):
        self.boundary.pulls = [self.boundary.pull(i, bot_branch("one")) for i in (1, 2)]
        with self.assertRaises(UpdateError):
            publish(self.root, self.candidate, self.client, self.runner)
        self.assertFalse(any(command[:2] == ["git", "push"] for command in self.git_commands))

    def test_fork_pull_with_same_head_name_is_not_hijacked(self):
        pull = self.boundary.pull(1, bot_branch("one"))
        pull["head"]["repo"]["full_name"] = "human/fork"
        self.boundary.pulls = [pull]
        with self.assertRaises(UpdateError):
            publish(self.root, self.candidate, self.client, self.runner)
        self.assertFalse(any(command[:2] == ["git", "push"] for command in self.git_commands))

    def test_reused_branch_race_stops_before_editing_pull(self):
        publish(self.root, self.candidate, self.client, self.runner)
        self.boundary.pulls[0]["body"] = "old body"
        self.boundary.requests.clear()
        def raced(command, **kwargs):
            result = self.runner(command, **kwargs)
            if command[:2] == ["git", "fetch"]:
                self.bare("update-ref", "refs/heads/" + bot_branch("one"), self.candidate.base_sha)
            return result
        with self.assertRaises(UpdateError):
            publish(self.root, self.candidate, self.client, raced)
        self.assertFalse(any(r.get_method() == "PATCH" for r in self.boundary.requests))

    def test_newly_pushed_branch_race_stops_before_creating_pull(self):
        def raced(command, **kwargs):
            result = self.runner(command, **kwargs)
            if command[:2] == ["git", "push"]:
                self.bare("update-ref", "refs/heads/" + bot_branch("one"), self.candidate.base_sha)
            return result
        with self.assertRaises(UpdateError):
            publish(self.root, self.candidate, self.client, raced)
        self.assertEqual(self.boundary.pulls, [])

    def test_default_branch_race_after_push_stops_before_creating_pull(self):
        def raced(command, **kwargs):
            result = self.runner(command, **kwargs)
            if command[:2] == ["git", "push"]:
                self.bare("update-ref", "refs/heads/main", self.branch_sha())
            return result
        with self.assertRaises(UpdateError):
            publish(self.root, self.candidate, self.client, raced)
        self.assertEqual(self.boundary.pulls, [])

    def test_lease_rejection_does_not_edit_pull_or_retry(self):
        publish(self.root, self.candidate, self.client, self.runner)
        path = self.root / "nix/dependency-pins.json"
        data = json.loads(path.read_text())
        data["a"]["rev"] = "v3.0.0"
        path.write_text(json.dumps(data))
        self.fixture.git("add", "nix/dependency-pins.json")
        next_candidate = dataclasses.replace(self.candidate, tree_sha=self.fixture.git("write-tree"),
            summary="Update a again", validated=False)
        next_candidate = validate(self.root, self.fixture.units["one"], next_candidate, self.fixture.runner)
        self.boundary.requests.clear()
        pushes = []
        def raced(command, **kwargs):
            if command[:2] == ["git", "push"]:
                pushes.append(command)
                self.bare("update-ref", "refs/heads/" + bot_branch("one"), self.candidate.base_sha)
            return self.runner(command, **kwargs)
        with self.assertRaises(UpdateError):
            publish(self.root, next_candidate, self.client, raced)
        self.assertEqual(len(pushes), 1)
        self.assertFalse(any(r.get_method() == "PATCH" for r in self.boundary.requests))


class APITests(unittest.TestCase):
    def test_unsafe_server_url_is_rejected_without_http(self):
        boundary = Mock()
        with self.assertRaises(UpdateError):
            ForgejoClient("http://forgejo.example", REPOSITORY, TOKEN, boundary)
        boundary.assert_not_called()

    def test_redirect_does_not_forward_token(self):
        boundary = HTTPBoundary()
        boundary.redirect = True
        client = ForgejoClient(SERVER, REPOSITORY, TOKEN, boundary)
        with self.assertRaises(UpdateError) as raised:
            client.current_user()
        self.assertEqual(len(boundary.requests), 1)
        self.assertNotIn(TOKEN, str(raised.exception))

    def test_malformed_user_response_is_rejected(self):
        client = ForgejoClient(SERVER, REPOSITORY, TOKEN, lambda request, timeout: Response([]))
        with self.assertRaises(UpdateError):
            client.current_user()


if __name__ == "__main__":
    unittest.main()
