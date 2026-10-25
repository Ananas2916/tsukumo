"""The accessibility tree: PowerShell's answer read in physical pixels, and the brain's names matched."""

import json

import pytest

from backend.uia import Element, match, parse


def test_parse_converts_to_the_real_window():
    # PowerShell not DPI-aware at 150%: everything it says is two thirds of the truth.
    raw = json.dumps(
        {
            "window": {"x": 100, "y": 50, "w": 800, "h": 600},
            "items": [{"n": "Salva", "t": "Button", "x": 110, "y": 60, "w": 40, "h": 20}],
        }
    )
    [element] = parse("﻿" + raw, {"x": 150, "y": 75, "width": 1200, "height": 900})
    assert element == Element("Salva", "Button", 165, 90, 60, 30)


def test_parse_survives_what_powershell_writes():
    # A lone element comes without the list; no window rectangle means no conversion.
    raw = json.dumps({"window": None, "items": {"n": "OK", "t": "Button", "x": 1, "y": 2, "w": 3, "h": 4}})
    assert parse(raw, {"x": 0, "y": 0, "width": 10, "height": 10}) == [Element("OK", "Button", 1, 2, 3, 4)]
    assert parse("not json", {}) == [] and parse("[]", {}) == []
    assert parse(json.dumps({"items": [{"t": "Button"}, "x"]}), {}) == []


TREE = [
    Element("File", "MenuItem", 0, 0, 40, 20),
    Element("Salva", "Pane", 0, 30, 400, 30),  # a toolbar bearing the same name
    Element("Salva", "Button", 10, 32, 24, 24),
    Element("Salva con nome…", "MenuItem", 0, 60, 120, 20),
    Element("Password", "Edit", 50, 100, 200, 24),
    Element("Password dimenticata?", "Hyperlink", 50, 130, 160, 18),
]


@pytest.mark.parametrize(
    ("description", "expected"),
    [
        ('the "Salva" button in the toolbar', TREE[2]),
        ("il pulsante «Salva»", TREE[2]),
        ('the "Password" field', TREE[4]),
        ('the link "Password dimenticata?"', TREE[5]),
        ('the "Salva con nome" menu item', TREE[3]),
        ('the "&File" menu', TREE[0]),
        # No quotes, or a name that isn't there: the eye decides.
        ("the save icon", None),
        ('the "Apri" button', None),
        # A fragment isn't a name.
        ('the "Pa" field', None),
    ],
)
def test_match_by_quoted_name(description, expected):
    assert match(description, TREE) == expected


def test_an_apostrophe_is_not_a_quote():
    assert match("l'AND a 2 ingressi", [Element("AND", "Button", 0, 0, 10, 10)]) is None
