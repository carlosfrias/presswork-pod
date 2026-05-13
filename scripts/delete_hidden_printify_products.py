"""Delete (or list) throwaway Printify products in the configured shop.

Dev-mode cleanup utility. Smoke runs (inject_image_smoke.py,
smoke_design_to_printify.py) and Listing-agent draft creates leave behind
products in the shop. Printify's list endpoint reports them all as
visible=True (regardless of the is_visible=False sent at create), so we can't
filter on that. Filter by title prefix instead — smoke scripts prefix titles
with "Smoke ", which is reliable.

Usage:
    source .venv/bin/activate
    python -m scripts.delete_hidden_printify_products                 # dry-run smoke-only
    python -m scripts.delete_hidden_printify_products --confirm       # delete smoke-only
    python -m scripts.delete_hidden_printify_products --all           # dry-run, EVERY product
    python -m scripts.delete_hidden_printify_products --all --confirm # delete EVERY product
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any

import httpx
from dotenv import load_dotenv


def _list_all_products(client: httpx.Client, shop_id: str) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    page = 1
    while True:
        # Printify caps `limit` at 50 per page; higher values 400.
        r = client.get(
            f"https://api.printify.com/v1/shops/{shop_id}/products.json",
            params={"limit": 50, "page": page},
            timeout=60,
        )
        r.raise_for_status()
        data = r.json()
        items = data.get("data", []) or []
        products.extend(items)
        last_page = int(data.get("last_page", 1) or 1)
        if page >= last_page or not items:
            break
        page += 1
    return products


SMOKE_TITLE_PREFIX = "Smoke "


def _is_smoke(product: dict[str, Any]) -> bool:
    title = product.get("title") or ""
    return title.startswith(SMOKE_TITLE_PREFIX)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Actually delete. Without this flag the script only lists.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Target EVERY product in the shop, not just smoke-prefixed ones.",
    )
    args = parser.parse_args()

    load_dotenv()
    token = os.environ.get("PRINTIFY_API_TOKEN")
    shop_id = os.environ.get("PRINTIFY_SHOP_ID")
    if not token or not shop_id:
        print("[cleanup] missing PRINTIFY_API_TOKEN or PRINTIFY_SHOP_ID in .env", file=sys.stderr)
        return 2

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "presswork/dev-cleanup",
    }
    with httpx.Client(headers=headers) as client:
        print(f"[cleanup] listing products in shop {shop_id}…")
        products = _list_all_products(client, shop_id)
        targets = products if args.all else [p for p in products if _is_smoke(p)]
        scope = (
            "ALL products"
            if args.all
            else f"smoke products (title startswith '{SMOKE_TITLE_PREFIX}')"
        )
        print(f"[cleanup] total in shop: {len(products)}  target ({scope}): {len(targets)}")

        if not targets:
            print("[cleanup] nothing to delete.")
            return 0

        for p in targets:
            pid = p.get("id")
            title = (p.get("title") or "")[:80]
            print(f"  - {pid}  {title}")

        if not args.confirm:
            print("\n[cleanup] dry-run only. Re-run with --confirm to delete.")
            return 0

        # Printify global rate limit is 600/min; deletion isn't in the publishing
        # class. Stay polite: 100ms gap = ≤10 req/sec, well under the limit.
        deleted = 0
        failed: list[tuple[str, int, str]] = []
        for p in targets:
            pid = p.get("id")
            if not pid:
                continue
            r = client.delete(
                f"https://api.printify.com/v1/shops/{shop_id}/products/{pid}.json",
                timeout=60,
            )
            if 200 <= r.status_code < 300:
                deleted += 1
                print(f"  ✓ deleted {pid}")
            else:
                failed.append((pid, r.status_code, r.text[:200]))
                print(f"  ✗ {pid} status={r.status_code} body={r.text[:200]}")
            time.sleep(0.1)

        print(f"\n[cleanup] deleted {deleted}/{len(targets)} products")
        if failed:
            print(f"[cleanup] {len(failed)} failed — inspect output above")
            return 1
        return 0


if __name__ == "__main__":
    sys.exit(main())
