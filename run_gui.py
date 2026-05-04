"""Launch the agent's web GUI.

Usage:
    python run_gui.py
    python run_gui.py --port 5050 --host 0.0.0.0
"""

from __future__ import annotations

import argparse
import webbrowser
from threading import Timer

from gui.server import serve


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run the Agent VS web GUI.")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5000)
    p.add_argument("--no-browser", action="store_true",
                   help="Don't auto-open the browser.")
    p.add_argument("--debug", action="store_true")
    return p.parse_args()


def main() -> int:
    args = _parse()
    if not args.no_browser:
        url = f"http://{args.host}:{args.port}"
        # Delay so the server is listening before the browser hits it.
        Timer(1.0, lambda: webbrowser.open(url)).start()
    serve(host=args.host, port=args.port, debug=args.debug)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
