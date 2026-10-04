"""Repository-scoped publication identity and configuration boundaries."""

import copy
import unittest

from maintenance.dependency_updates.forgejo_api import ForgejoClient
from maintenance.dependency_updates.model import UpdateError
from maintenance.tests.test_dependency_publish import HTTPBoundary, REPOSITORY, SERVER, TOKEN


class RepositoryIdentityTests(unittest.TestCase):
    def setUp(self):
        self.boundary = HTTPBoundary()

    def client(self, username="dependency-bot"):
        return ForgejoClient(SERVER, REPOSITORY, TOKEN, self.boundary, bot_username=username)

    def test_repository_permissions_resolve_the_publication_account(self):
        actor = self.client().current_user()
        self.assertEqual(actor, {"id": 7, "login": "dependency-bot"})
        self.assertEqual(len(self.boundary.requests), 1)
        request = self.boundary.requests[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url,
            "https://forgejo.example/api/v1/repos/owner/repo/collaborators/dependency-bot/permission")

    def test_username_case_preserves_the_server_identity(self):
        actor = self.client("DEPENDENCY-BOT").current_user()
        self.assertEqual(actor, {"id": 7, "login": "dependency-bot"})

    def test_write_access_levels_are_accepted(self):
        for permission in ("write", "admin", "owner"):
            with self.subTest(permission=permission):
                self.boundary.permission_response.update(permission=permission, role_name=permission)
                self.assertEqual(self.client().current_user(), {"id": 7, "login": "dependency-bot"})

    def test_invalid_username_is_rejected_before_http(self):
        for username in (None, "", ".", "..", "other/user", "../other", "user?x", "user#x",
                "user\n", "user name", 7, True):
            with self.subTest(username=username):
                with self.assertRaises(UpdateError):
                    self.client(username).current_user()
        self.assertEqual(self.boundary.requests, [])

    def test_malformed_repository_user_is_rejected(self):
        responses = [None, [], {}, {"permission": "write", "user": None},
            {"permission": "write", "user": []}, {"permission": "write", "user": {}}]
        for field, values in (("id", (None, True, 0, -1, "7")),
                ("login", (None, True, "", "other-user", "../dependency-bot", "dependency-bot\n"))):
            for value in values:
                response = copy.deepcopy(self.boundary.permission_response)
                response["user"][field] = value
                responses.append(response)
        for response in responses:
            with self.subTest(response=response):
                self.boundary.permission_response = response
                with self.assertRaises(UpdateError):
                    self.client().current_user()

    def test_missing_or_invalid_write_permission_is_rejected(self):
        for permission in (None, "none", "read", "", "unknown", True, [], {}):
            with self.subTest(permission=permission):
                self.boundary.permission_response["permission"] = permission
                with self.assertRaises(UpdateError):
                    self.client().current_user()

    def test_wrong_token_owner_is_rejected_by_repository_api(self):
        with self.assertRaises(UpdateError) as raised:
            self.client("other-user").current_user()
        self.assertIn("403", str(raised.exception))
        self.assertNotIn(TOKEN, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
