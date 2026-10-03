"""A bounded Forgejo client that never forwards credentials on redirects."""

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from .model import UpdateError


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


class ForgejoClient:
    def __init__(self, server_url: str, repository: str, token: str, request=None):
        try:
            parsed = urllib.parse.urlsplit(server_url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError()
            self.origin = (parsed.scheme, parsed.hostname, parsed.port or 443)
            if any(part in {".", ".."} for part in parsed.path.split("/")):
                raise ValueError()
            if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or any(part in {".", ".."} for part in repository.split("/")):
                raise ValueError()
            if not isinstance(token, str) or not token or any(ord(char) < 32 for char in token):
                raise ValueError()
        except (TypeError, ValueError) as error:
            raise UpdateError("publication", "Invalid HTTPS server, repository, or token configuration") from error
        self.server_url, self.repository, self.token = server_url.rstrip("/"), repository, token
        self.git_url = self.server_url + "/" + repository + ".git"
        self._request = request or urllib.request.build_opener(NoRedirect()).open

    def check_url(self, url: str) -> str:
        try:
            parsed = urllib.parse.urlsplit(url)
            if (parsed.scheme, parsed.hostname, parsed.port or 443) != self.origin or parsed.username or parsed.password or parsed.fragment:
                raise ValueError()
        except (TypeError, ValueError) as error:
            raise UpdateError("publication", "Response URL does not match configured server origin") from error
        return url

    def check_git_remote(self, url: str) -> None:
        self.check_url(url)
        parsed = urllib.parse.urlsplit(url)
        wanted = urllib.parse.urlsplit(self.git_url).path
        if parsed.query or parsed.path not in {wanted, wanted.removesuffix(".git")}:
            raise UpdateError("publication", "Git origin does not match the configured repository")

    def _api(self, method: str, path: str, payload=None):
        url = self.server_url + "/api/v1" + path
        self.check_url(url)
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "token " + self.token, "Accept": "application/json",
            "Content-Type": "application/json", "User-Agent": "roche-pi-dependency-updater",
        })
        try:
            with self._request(request, timeout=30) as response:
                if not 200 <= response.status < 300:
                    raise UpdateError("publication", f"Forgejo API returned HTTP {response.status}")
                content = response.read(5 * 1024 * 1024 + 1)
            if len(content) > 5 * 1024 * 1024:
                raise ValueError()
            return json.loads(content)
        except urllib.error.HTTPError as error:
            raise UpdateError("publication", f"Forgejo API returned HTTP {error.code}") from None
        except (OSError, ValueError) as error:
            raise UpdateError("publication", "Forgejo API transport or JSON response failed") from None

    def current_user(self) -> dict:
        data = self._api("GET", "/user")
        if not isinstance(data, dict) or type(data.get("id")) is not int or data["id"] <= 0 or not isinstance(data.get("login"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", data["login"]):
            raise UpdateError("publication", "Forgejo user response is invalid")
        return data

    def open_pulls(self) -> list[dict]:
        pulls = []
        for page in range(1, 1001):
            data = self._api("GET", f"/repos/{self.repository}/pulls?state=open&limit=50&page={page}")
            if not isinstance(data, list) or any(not isinstance(pull, dict) for pull in data):
                raise UpdateError("publication", "Forgejo pull list response is invalid")
            pulls.extend(data)
            if len(data) < 50:
                return pulls
        raise UpdateError("publication", "Forgejo pull pagination exceeded its limit")

    def _pull(self, data) -> dict:
        if not isinstance(data, dict) or type(data.get("number")) is not int or data["number"] <= 0 or not isinstance(data.get("html_url"), str):
            raise UpdateError("publication", "Forgejo pull response is invalid")
        self.check_url(data["html_url"])
        return data

    def create_pull(self, head: str, base: str, title: str, body: str) -> dict:
        return self._pull(self._api("POST", f"/repos/{self.repository}/pulls", {
            "head": head, "base": base, "title": title, "body": body,
        }))

    def update_pull(self, number: int, title: str, body: str) -> dict:
        if type(number) is not int or number <= 0:
            raise UpdateError("publication", "Invalid pull request number")
        return self._pull(self._api("PATCH", f"/repos/{self.repository}/pulls/{number}", {"title": title, "body": body}))
