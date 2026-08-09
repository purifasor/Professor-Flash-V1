# -*- coding: utf-8 -*-
"""Persian text utilities: normalization, tokenization, digit conversion.

Professor Flash works on the raw text as the user typed it, but all
*matching* is done on a "soft" version (normalized, tashkeel removed,
ZWNJ stripped, lowercased) so spelling variants like ميشود/می‌شود and
Arabic ي/ك variants all match correctly.
"""

import re
import unicodedata

# Arabic letters that Persians type as Latin-equivalents or different forms
CHAR_MAP = {
    "ي": "ی",
    "ك": "ک",
    "ة": "ه",
    "ۀ": "ه",
    "أ": "ا",
    "إ": "ا",
    "آ": "ا",
    "ٱ": "ا",
    "ؤ": "و",
    "ئ": "ی",
    "ى": "ی",
}

TASHKEEL_RE = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED]")

PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
LATIN_DIGITS = "0123456789"

_P2L = str.maketrans(PERSIAN_DIGITS + ARABIC_DIGITS, LATIN_DIGITS * 2)
_L2P = str.maketrans(LATIN_DIGITS, PERSIAN_DIGITS)


def normalize(text: str) -> str:
    """NFKC + unify Arabic glyphs to Persian forms + strip tashkeel."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    for src, dst in CHAR_MAP.items():
        text = text.replace(src, dst)
    text = TASHKEEL_RE.sub("", text)
    return text


def soft(text: str) -> str:
    """Normalized, ZWNJ-stripped, lowercased text used for keyword matching."""
    t = normalize(text)
    t = t.replace("\u200c", " ").replace("\u200f", "").replace("\u200e", "")
    return t.lower().strip()


def to_ascii_digits(text: str) -> str:
    """Convert Persian/Arabic digits to ASCII digits."""
    return text.translate(_P2L)


def to_persian_digits(text: str) -> str:
    """Convert ASCII digits to Persian digits."""
    return text.translate(_L2P)


def words(text: str) -> list:
    """Word tokens of the soft text (letters/digits runs)."""
    return re.findall(r"[\w\u0600-\u06FF]+", soft(text))


def contains(text: str, *patterns: str) -> bool:
    """True if any pattern (as soft text) appears in the soft text."""
    s = soft(text)
    return any(soft(p) in s for p in patterns)


def contains_any(text: str, patterns) -> bool:
    s = soft(text)
    return any(soft(p) in s for p in patterns)


def has_latin(word: str) -> bool:
    return bool(re.search(r"[a-zA-Z]", word))


def strip_urls(text: str) -> str:
    return re.sub(r"https?://\S+|www\.\S+", " ", text)


def clean_for_display(text: str) -> str:
    """Normalize for display, keep ZWNJ so Persian looks right."""
    t = normalize(text)
    t = re.sub(r"\s+", " ", t).strip()
    return t
