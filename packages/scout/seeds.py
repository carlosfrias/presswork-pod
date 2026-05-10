import os

_override = os.environ.get("NICHE_SEEDS_OVERRIDE")

NICHE_SEEDS: list[str] = (
    [n.strip() for n in _override.split(",") if n.strip()]
    if _override
    else [
        # Motivational / inspirational
        "motivational quotes",
        "positive affirmations",
        "inspirational typography",
        # Pet-themed
        "dog mom gifts",
        "cat lover gifts",
        "funny pet names",
        # Occupation / identity
        "nurse appreciation gifts",
        "teacher gifts funny",
        "engineer humor",
        # Seasonal evergreen
        "funny retirement gifts",
    ]
)
