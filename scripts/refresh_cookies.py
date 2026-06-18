#!/usr/bin/env python3
"""Refresh TeamPlus cookies via patchright (stealth Playwright).

Reads TEAMPLUS_ACCOUNT and TEAMPLUS_PASSWORD from `.env`, drives Chromium
through the TeamPlus login flow (TEAMPLUS_BASE), OCRs the captcha with
tesseract, and writes fresh session cookies to `cookies.json`. Also decodes
the TSSID JWT to populate `.config.json` with `my_id` if absent.

Usage:
    python scripts/refresh_cookies.py              # headless (default)
    python scripts/refresh_cookies.py --headful    # show browser window
    python scripts/refresh_cookies.py --attempts 5 # retry captcha N times

Exit codes:
    0  success
    1  config / creds error
    3  login failed after all captcha attempts
    4  tesseract not installed
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from patchright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
COOKIES_FILE = ROOT / "cookies.json"
CONFIG_FILE = ROOT / ".config.json"
def _env_teamplus_base() -> str:
    """Read TEAMPLUS_BASE (origin, no trailing slash) from .env at import time.

    Kept separate from load_env() because the login URL + cookie domain are
    module-level constants. No organisation URL is hardcoded here.
    """
    base = ""
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text().splitlines():
            line = raw.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key.strip() == "TEAMPLUS_BASE":
                base = val.strip()
    base = base.rstrip("/")
    if not base:
        print(
            "ERROR: TEAMPLUS_BASE must be set in .env (copy .env.example to .env)",
            file=sys.stderr,
        )
        sys.exit(1)
    return base


TEAMPLUS_BASE = _env_teamplus_base()
TEAMPLUS_HOST = TEAMPLUS_BASE.split("://", 1)[-1].split("/", 1)[0]
LOGIN_URL = TEAMPLUS_BASE + "/"
REQUIRED_COOKIES = {"TSSID", "MRSSID", "LR"}
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
)
CAPTCHA_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_env() -> dict[str, str]:
    """Minimal `.env` parser. Only KEY=VALUE lines, no quoting / interpolation."""
    if not ENV_FILE.exists():
        log(f"ERROR: {ENV_FILE} not found.")
        log("  → Create it by running: ./scripts/setup_creds.sh")
        sys.exit(1)
    env: dict[str, str] = {}
    for raw in ENV_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip()
    account = env.get("TEAMPLUS_ACCOUNT", "")
    password = env.get("TEAMPLUS_PASSWORD", "")
    if not account or not password:
        log("ERROR: TEAMPLUS_ACCOUNT and TEAMPLUS_PASSWORD must be set in .env")
        log("  → Re-run: ./scripts/setup_creds.sh")
        sys.exit(1)
    return {"account": account, "password": password}


def merge_cookies(new_cookies: list[dict]) -> None:
    existing: list[dict] = []
    if COOKIES_FILE.exists():
        try:
            existing = json.loads(COOKIES_FILE.read_text())
        except json.JSONDecodeError:
            existing = []
    kept = [c for c in existing if TEAMPLUS_HOST not in c.get("domain", "")]
    for c in new_cookies:
        kept.append(
            {
                "domain": c["domain"],
                "name": c["name"],
                "value": c["value"],
                "path": c.get("path", "/"),
                "expires": c.get("expires", -1),
                "httpOnly": c.get("httpOnly", False),
                "secure": c.get("secure", False),
                "sameSite": c.get("sameSite", "Lax"),
            }
        )
    COOKIES_FILE.write_text(json.dumps(kept, indent=2, ensure_ascii=False) + "\n")


def get_cookie(context, name: str) -> str | None:
    for c in context.cookies():
        if c["name"] == name and TEAMPLUS_HOST in c.get("domain", ""):
            return c["value"]
    return None


def decode_tssid(tssid: str) -> dict | None:
    """TSSID format: `SV=<jwt>` where jwt has 3 base64url segments. Decode payload."""
    raw = tssid.split("=", 1)[-1] if "=" in tssid else tssid
    parts = raw.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    # base64url decode with padding fix
    padding = "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload + padding)
        return json.loads(decoded)
    except (ValueError, json.JSONDecodeError):
        return None


def update_my_id_from_tssid(tssid: str | None) -> int | None:
    if not tssid:
        return None
    payload = decode_tssid(tssid)
    if not payload:
        return None
    un = payload.get("un")
    if not isinstance(un, int):
        return None
    cfg: dict = {}
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text())
        except json.JSONDecodeError:
            cfg = {}
    if cfg.get("my_id") == un:
        return un
    cfg["my_id"] = un
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2) + "\n")
    log(f"✓ Wrote my_id={un} to {CONFIG_FILE.name}")
    return un


def ocr_captcha(png_path: Path) -> str:
    result = subprocess.run(
        [
            "tesseract", str(png_path), "stdout",
            "--psm", "8",
            "-c", f"tessedit_char_whitelist={CAPTCHA_WHITELIST}",
        ],
        capture_output=True, text=True, timeout=10,
    )
    raw = result.stdout.strip()
    return "".join(c for c in raw if c in CAPTCHA_WHITELIST)


def attempt_login(page, context, creds: dict, attempt: int) -> tuple[bool, str]:
    page.fill("#txt_account", creds["account"])
    page.fill("#txt_password", creds["password"])
    page.fill("#txt_verifyCode", "")

    captcha_png = ROOT / "logs" / f"captcha_attempt{attempt}.png"
    captcha_png.parent.mkdir(exist_ok=True)
    page.locator("#img_verifyCode").screenshot(path=str(captcha_png))

    guess = ocr_captcha(captcha_png)
    log(f"  attempt {attempt}: OCR guess = '{guess}' (from {captcha_png.name})")
    if not guess:
        return False, guess

    page.fill("#txt_verifyCode", guess)
    initial_tssid = get_cookie(context, "TSSID")
    page.click("#btn_login")

    deadline = time.time() + 8
    while time.time() < deadline:
        cur = get_cookie(context, "TSSID")
        if cur and cur != initial_tssid:
            return True, guess
        time.sleep(0.3)
    return False, guess


def refresh_captcha(page) -> None:
    try:
        page.locator(".img_refresh").first.click(timeout=2000)
        time.sleep(0.8)
    except Exception as e:
        log(f"  (captcha refresh click failed: {e}; forcing reload)")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("#txt_account")


def dump_debug(page, tag: str) -> None:
    debug_dir = ROOT / "logs"
    debug_dir.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    shot = debug_dir / f"refresh_{tag}_{ts}.png"
    html = debug_dir / f"refresh_{tag}_{ts}.html"
    try:
        page.screenshot(path=str(shot), full_page=True)
        html.write_text(page.content())
        log(f"  debug: logs/{shot.name}, logs/{html.name}")
    except Exception as e:
        log(f"  debug dump failed: {e}")


def run(headless: bool, attempts: int) -> int:
    if not shutil.which("tesseract"):
        log("ERROR: tesseract not installed. Install with: brew install tesseract")
        return 4

    creds = load_env()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(user_agent=USER_AGENT)
        page = context.new_page()

        log(f"→ Loading {LOGIN_URL}")
        page.goto(LOGIN_URL, wait_until="domcontentloaded")
        page.wait_for_selector("#txt_account", timeout=15_000)

        for i in range(1, attempts + 1):
            ok, guess = attempt_login(page, context, creds, i)
            if ok:
                log(f"✓ Login succeeded on attempt {i} (captcha: '{guess}')")
                break
            log(f"  attempt {i} failed; refreshing captcha")
            refresh_captcha(page)
        else:
            log(f"ERROR: login failed after {attempts} attempts.")
            dump_debug(page, "failed")
            browser.close()
            return 3

        tp_cookies = [c for c in context.cookies() if TEAMPLUS_HOST in c.get("domain", "")]
        got_names = {c["name"] for c in tp_cookies}
        missing = REQUIRED_COOKIES - got_names
        if missing:
            log(f"WARN: missing expected cookies: {missing}")

        merge_cookies(tp_cookies)
        log(f"✓ Wrote {len(tp_cookies)} cookies ({', '.join(sorted(got_names))}) to {COOKIES_FILE.name}")

        update_my_id_from_tssid(get_cookie(context, "TSSID"))

        browser.close()
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else "")
    ap.add_argument("--headful", action="store_true", help="Show browser window (default: headless)")
    ap.add_argument("--attempts", type=int, default=5, help="Captcha retry attempts (default: 5)")
    args = ap.parse_args()
    return run(headless=not args.headful, attempts=args.attempts)


if __name__ == "__main__":
    # Ensure cwd-independent logs dir is created lazily by callers
    os.umask(0o077)
    sys.exit(main())
