import json
from unittest.mock import MagicMock

import httpx
import pytest
import respx

from packages.scout.dedup import is_semantic_duplicate

_CAT_BRIEFS = [
    {"niche": "cat lovers", "style_keywords": ["cute", "minimalist"]},
    {"niche": "kitten tees", "style_keywords": ["playful", "colorful"]},
    {"niche": "funny cat shirts", "style_keywords": ["humorous", "cartoon"]},
    {"niche": "cat mom gifts", "style_keywords": ["warm", "illustrated"]},
    {"niche": "crazy cat lady", "style_keywords": ["retro", "bold"]},
]

_DOG_BRIEFS = [
    {"niche": "dog mom gifts", "style_keywords": ["warm", "illustrated"]},
    {"niche": "labrador lover", "style_keywords": ["realistic", "nature"]},
    {"niche": "funny dog shirts", "style_keywords": ["humorous", "cartoon"]},
    {"niche": "rescue dog tees", "style_keywords": ["heart", "minimalist"]},
    {"niche": "golden retriever", "style_keywords": ["warm", "playful"]},
]

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"


def _make_db(recent_data: list) -> MagicMock:
    db = MagicMock()
    chain = MagicMock()
    chain.select.return_value.gte.return_value.order.return_value.limit.return_value.execute.return_value.data = recent_data
    db.table.return_value = chain
    return db


def _mock_settings(mocker):
    s = MagicMock()
    s.anthropic_api_key = "test-key"
    mocker.patch("packages.scout.dedup.get_settings", return_value=s)


@pytest.mark.asyncio
@respx.mock
async def test_fixture_a_cat_briefs_are_duplicate(mocker):
    _mock_settings(mocker)
    db = _make_db(_CAT_BRIEFS)

    respx.post(_ANTHROPIC_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps({"is_duplicate": True, "matched_niche": "cat lovers"}),
                    }
                ]
            },
        )
    )

    is_dup, matched = await is_semantic_duplicate("cat lover gifts", db)

    assert is_dup is True
    assert matched == "cat lovers"


@pytest.mark.asyncio
@respx.mock
async def test_fixture_b_dog_briefs_are_not_cat_duplicate(mocker):
    _mock_settings(mocker)
    db = _make_db(_DOG_BRIEFS)

    respx.post(_ANTHROPIC_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps({"is_duplicate": False, "matched_niche": None}),
                    }
                ]
            },
        )
    )

    is_dup, matched = await is_semantic_duplicate("cat gifts", db)

    assert is_dup is False
    assert matched is None


@pytest.mark.asyncio
async def test_fixture_c_empty_prior_list_skips_claude(mocker):
    _mock_settings(mocker)
    db = _make_db([])  # no recent briefs

    mock_anthropic = MagicMock()
    mocker.patch("packages.scout.dedup.AsyncAnthropic", return_value=mock_anthropic)

    is_dup, matched = await is_semantic_duplicate("cat gifts", db)

    assert is_dup is False
    assert matched is None
    mock_anthropic.messages.create.assert_not_called()
