"""Caption assembly — pure functions between forced alignment and export.

Word timestamps (from the align backend) become short readable cues; cues
serialize to SRT (the caption node's artifact and the sidecar format) and to
styled ASS for burn-in. Short-form pacing: few words per cue, bottom-third,
strong outline.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

MAX_CUE_WORDS = 5
MAX_CUE_SPAN_S = 2.4
CUE_GAP_BREAK_S = 0.6  # a pause this long starts a new cue
_STRONG_ENDS = (".", "!", "?")
_WEAK_ENDS = (",", ";", ":")
# A comma only earns a cue break once the cue carries enough words: script
# punctuation (restored by anchoring) is far denser than what transcription
# emits, and breaking on every comma leaves single words flashing on screen.
MIN_WEAK_BREAK_WORDS = 3


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Cue:
    start: float
    end: float
    text: str


def _norm(token: str) -> str:
    return re.sub(r"[^a-z0-9']+", "", token.lower())


def anchor_words_to_text(words: list[Word], text: str) -> list[Word]:
    """Replace ASR word text with the narration's ground-truth tokens,
    keeping the ASR timings. Free transcription mishears homophones
    ("sun" → "son") and drops the script's punctuation/casing — but the
    narration audio was synthesized FROM the script, so the script is the
    truth and the audio only contributes timing."""
    truth = text.split()
    if not truth or not words:
        return words
    truth_norm = [_norm(t) for t in truth]
    # Punctuation-only and non-Latin tokens normalize to "" and would anchor
    # arbitrarily; when they dominate (non-English narration), the text isn't
    # alignable this way — keep the transcription.
    if sum(1 for t in truth_norm if not t) > len(truth_norm) // 2:
        return words
    matcher = difflib.SequenceMatcher(
        a=[_norm(w.text) for w in words], b=truth_norm, autojunk=False
    )
    out: list[Word] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                out.append(Word(text=truth[j1 + k], start=words[i1 + k].start, end=words[i1 + k].end))
        elif tag == "replace":
            # Misheard span: spread the true tokens over its time window.
            # ASR occasionally emits zero-width words — give the span a floor
            # so no cue ends up with start == end (it would never display).
            start, end = words[i1].start, words[i2 - 1].end
            if end <= start:
                end = start + 0.15 * (j2 - j1)
            step = (end - start) / (j2 - j1)
            for k in range(j2 - j1):
                out.append(
                    Word(text=truth[j1 + k], start=start + k * step, end=start + (k + 1) * step)
                )
        elif tag == "insert":
            # Tokens the ASR never emitted: lay them into the following gap
            # (or a nominal window at the tail) with a per-word floor — a
            # zero-width cue would be silently dropped by SRT consumers.
            n = j2 - j1
            anchor = out[-1].end if out else words[0].start
            following = words[i1].start if i1 < len(words) else anchor + 0.4 * n
            step = max((following - anchor) / n, 0.15)
            for k in range(n):
                out.append(
                    Word(text=truth[j1 + k], start=anchor + k * step, end=anchor + (k + 1) * step)
                )
        # "delete": the ASR hallucinated a word the script doesn't have — drop it.
    return out


def words_to_cues(words: list[Word]) -> list[Cue]:
    """Group word timestamps into short cues, breaking on pauses,
    punctuation, word count and span."""
    cues: list[Cue] = []
    current: list[Word] = []

    def flush() -> None:
        if current:
            text = " ".join(w.text.strip() for w in current).strip()
            if text:
                cues.append(Cue(start=current[0].start, end=current[-1].end, text=text))
            current.clear()

    for word in words:
        if current:
            span = word.end - current[0].start
            gap = word.start - current[-1].end
            if len(current) >= MAX_CUE_WORDS or span > MAX_CUE_SPAN_S or gap > CUE_GAP_BREAK_S:
                flush()
        current.append(word)
        token = word.text.strip()
        if token.endswith(_STRONG_ENDS) or (
            token.endswith(_WEAK_ENDS) and len(current) >= MIN_WEAK_BREAK_WORDS
        ):
            flush()
    flush()
    return cues


def _srt_time(seconds: float) -> str:
    ms = max(0, round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def cues_to_srt(cues: list[Cue]) -> str:
    blocks = [
        f"{i + 1}\n{_srt_time(c.start)} --> {_srt_time(c.end)}\n{c.text}\n"
        for i, c in enumerate(cues)
    ]
    return "\n".join(blocks)


def parse_srt(text: str) -> list[Cue]:
    cues: list[Cue] = []
    # Normalize CRLF/CR first: canonical SubRip separates cue blocks with
    # "\r\n\r\n", which a bare split("\n\n") never matches — collapsing the
    # whole file into one garbled cue.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for block in text.strip().split("\n\n"):
        lines = [line for line in block.splitlines() if line.strip()]
        timing = next((line for line in lines if "-->" in line), None)
        if timing is None:
            continue
        start_raw, _, end_raw = timing.partition("-->")
        try:
            start, end = _parse_srt_time(start_raw), _parse_srt_time(end_raw)
        except ValueError:
            continue
        body = lines[lines.index(timing) + 1 :]
        if body:
            cues.append(Cue(start=start, end=end, text=" ".join(body)))
    return cues


def _parse_srt_time(raw: str) -> float:
    h, m, s = raw.strip().replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def _ass_time(seconds: float) -> str:
    cs = max(0, round(seconds * 100))
    h, rem = divmod(cs, 360_000)
    m, rem = divmod(rem, 6_000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02}:{s:02}.{cs:02}"


_ASS_HEADER = """\
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Default,Sans,84,&H00FFFFFF,&H00101014,&H80000000,-1,5,1,2,60,60,340

[Events]
Format: Layer, Start, End, Style, Text
"""


def srt_to_ass(srt_text: str) -> str:
    """Sidecar SRT → styled burn-in ASS (bottom-third, bold, outlined)."""
    lines = [
        "Dialogue: 0,{},{},Default,{}".format(
            _ass_time(c.start),
            _ass_time(c.end),
            c.text.replace("\n", r"\N").replace("{", "(").replace("}", ")"),
        )
        for c in parse_srt(srt_text)
    ]
    return _ASS_HEADER + "\n".join(lines) + "\n"
